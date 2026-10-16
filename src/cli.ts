#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { detectCodebaseSource, parseCodebaseTokens } from "./codebase/index.js";
import { diffComponents } from "./components.js";
import { loadConfig } from "./config.js";
import { applyDeprecations } from "./deprecations.js";
import { diffTokens, hasDrift } from "./diff.js";
import { connectBridge, type BridgeCaller } from "./figma/bridge.js";
import { FigmaClient, type FigmaApi } from "./figma/client.js";
import { fetchFigmaTokens } from "./figma/source.js";
import {
  buildNotifyMessage,
  decideNotification,
  driftFingerprint,
  postNotification,
  readNotifyState,
  writeNotifyState,
  type NotifyState,
} from "./notify.js";
import { buildReport, buildStatusPayload } from "./report.js";
import { buildSampleConfig, createSampleFigmaApi, type SampleFormat } from "./sample.js";
import type { DriftConfig } from "./types.js";
import {
  DEFAULT_PASSCODE_ENV,
  generatePasscode,
  listWebhooks,
  registerWebhooks,
} from "./webhook.js";

const USAGE = `elf-tokens — design token drift checker

Compares Figma design tokens against the tokens in your codebase and
reports value mismatches and missing tokens on either side.

Usage:
  elf-tokens [options]
  elf-tokens webhook [options]
  npm run check-drift [options]

Commands:
  webhook              Register Figma webhooks that notify the repo
                       when tokens change in the file (see --help with
                       the webhook command for details).

Options:
  --config <path>        Path to the config file (default: elf.config.json)
  --out <path>           Where to write the markdown report (default: drift-report.md)
  --sample [format]      Run against bundled sample data, no Figma token needed.
                         Optional format: variables | styles | tailwind | css | tokens-json
  --fail-on-drift        Exit with code 2 when drift is found (off by default)
  --notify               Post a summary to the webhook named by "notify.webhookEnv"
                         in the config (a Slack incoming webhook by default), only
                         when the drift state changed since the last run
  --help                 Show this help

Requires the Figma API token in the environment variable named by
figma.apiTokenEnv in the config (default: FIGMA_API_TOKEN). The notify
webhook URL also lives in an environment variable — it is never stored
in the config itself.
`;

const WEBHOOK_USAGE = `elf-tokens webhook — wire Figma token changes to this repo

Register (or update) webhooks on the Figma file so that token edits
trigger a GitHub Actions run via your Cloudflare Worker bridge:

  Figma file ──webhook POST──► Worker (passcode check) ──dispatch──► GitHub Actions

Usage:
  elf-tokens webhook [options]
  elf-tokens webhook --list
  elf-tokens webhook --test

Options:
  --endpoint <url>      Your worker URL (default: webhook.endpoint in the config)
  --list                List webhooks currently registered for the file
  --test                Send a fake Figma event through the worker and report the result
  --config <path>       Path to the config file (default: elf.config.json)
  --help                Show this help

Environment:
  <figma.apiTokenEnv>   Figma API token (default: FIGMA_API_TOKEN)
  <webhook.passcodeEnv> Passcode for the worker (default: FIGMA_WEBHOOK_PASSCODE).
                        Set it before registering so it matches the worker's
                        FIGMA_PASSCODE secret; otherwise one is generated and printed.
`;

interface CliArgs {
  help: boolean;
  sample: string | boolean;
  config?: string;
  out?: string;
  failOnDrift?: boolean;
  notify?: boolean;
  endpoint?: string;
  list?: boolean;
  test?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false, sample: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--fail-on-drift") {
      args.failOnDrift = true;
    } else if (arg === "--sample") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args.sample = next;
        i++;
      } else {
        args.sample = true;
      }
    } else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq > -1 ? arg.slice(2, eq) : arg.slice(2);
      const inlineValue = eq > -1 ? arg.slice(eq + 1) : undefined;
      const next = argv[i + 1];
      const record = args as unknown as Record<string, unknown>;
      if (inlineValue !== undefined) {
        record[key] = inlineValue;
      } else if (next && !next.startsWith("--")) {
        record[key] = next;
        i++;
      } else {
        record[key] = true;
      }
    }
  }
  return args;
}

async function main(): Promise<number> {
  const rawArgs = process.argv.slice(2);
  const [command, ...rest] = rawArgs[0] && !rawArgs[0].startsWith("-") ? rawArgs : ["", ...rawArgs];
  const args = parseArgs(rest);
  if (args.help) {
    console.log(command === "webhook" ? WEBHOOK_USAGE : USAGE);
    return 0;
  }
  if (command === "webhook") {
    return runWebhookCommand(args);
  }

  const config: DriftConfig = args.sample
    ? buildSampleConfig(typeof args.sample === "string" ? (args.sample as SampleFormat) : undefined)
    : loadConfig(args.config ?? "elf.config.json");

  if (args.notify) {
    if (!config.notify) {
      throw new Error('--notify needs a "notify" section in the config, e.g. {"notify": {"webhookEnv": "SLACK_WEBHOOK_URL"}}.');
    }
    if (!process.env[config.notify.webhookEnv]) {
      throw new Error(
        `Webhook URL not found. Set the ${config.notify.webhookEnv} environment variable ` +
          `(the URL itself is never stored in the config).`,
      );
    }
  }
  const webhookUrl = config.notify ? process.env[config.notify.webhookEnv] ?? "" : "";

  let api: FigmaApi | null = null;
  const restApi = (): FigmaApi => {
    api ??= args.sample ? createSampleFigmaApi() : createLiveApi(config);
    return api;
  };

  let bridge: BridgeCaller | null = null;
  const getBridge = async (): Promise<BridgeCaller> => {
    bridge ??= await connectBridge();
    return bridge;
  };

  try {
    return await runDriftCheck(args, config, restApi, getBridge, webhookUrl);
  } finally {
    // The bridge websocket would otherwise keep the process alive after the report.
    bridge?.close();
  }
}

async function runDriftCheck(
  args: CliArgs,
  config: DriftConfig,
  restApi: () => FigmaApi,
  getBridge: () => Promise<BridgeCaller>,
  webhookUrl: string,
): Promise<number> {
  const { tokens: figmaTokens, source: figmaSource } = await fetchFigmaTokens(config, restApi, getBridge);

  const codebaseSource =
    config.codebase.source === "auto" ? detectCodebaseSource(config.codebase.path) : config.codebase.source;
  const codeTokens = await parseCodebaseTokens(codebaseSource, config.codebase.path);

  let result = diffTokens(figmaTokens, codeTokens, config.nameMapping);

  let codeComponents: { name: string; codeKey: string }[] = [];
  if (config.components) {
    const componentDiff = await diffComponents(
      config.components.path,
      config.components.manifest,
      await getBridge(),
    );
    codeComponents = componentDiff.codeComponents;
    result = {
      ...result,
      componentsOutOfDate: componentDiff.outOfDate,
      componentsChangedInFigma: componentDiff.changedInFigma,
      componentsInCodeNotInFigma: componentDiff.inCodeNotInFigma,
      componentsInFigmaNotInCode: componentDiff.inFigmaNotInCode,
    };
    result.driftFound = hasDrift(result);
  }

  result = applyDeprecations(
    result,
    config.deprecations,
    { codeTokens, codeComponents },
    new Date().toISOString().slice(0, 10),
  );

  const meta = {
    fileKey: config.figma.fileKey,
    figmaSource,
    codebaseSource,
    figmaTokenCount: figmaTokens.length,
    codeTokenCount: codeTokens.length,
    checkedAt: new Date().toISOString(),
  };
  const report = buildReport(result, meta);

  const outPath = resolve(args.out ?? "drift-report.md");
  const statusPath = join(dirname(outPath), "drift-status.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${report}\n`);

  console.log(report);
  console.log(`\nReport written to ${outPath} (${result.driftFound ? "drift found" : "clean"}).`);
  console.log("Exit code reflects drift only with --fail-on-drift.");

  let statusFingerprint = driftFingerprint(result);

  if (args.notify && config.notify) {
    const notifyConfig = config.notify;
    const statePath = notifyConfig.stateFile ?? statusPath;
    const previousState = readNotifyState(statePath);
    const decision = decideNotification(previousState, result);

    let posted = false;
    if (decision.send) {
      try {
        await postNotification(
          webhookUrl,
          notifyConfig.format,
          buildNotifyMessage(result, meta, notifyConfig.format, previousState),
        );
        posted = true;
        console.log(`Notification posted (via ${notifyConfig.webhookEnv}).`);
      } catch (error) {
        console.error(`Notification failed: ${(error as Error).message}`);
      }
    } else {
      console.log("No notification sent: drift state unchanged since the last run.");
    }

    // Keep the old state on a failed post so the next run retries.
    const persist: NotifyState | null =
      decision.send && !posted ? previousState : { fingerprint: decision.fingerprint, driftFound: result.driftFound };
    if (notifyConfig.stateFile) {
      if (persist) writeNotifyState(notifyConfig.stateFile, persist);
    } else {
      statusFingerprint = persist?.fingerprint ?? "";
    }
  }

  writeFileSync(
    statusPath,
    JSON.stringify({ ...buildStatusPayload(result), fingerprint: statusFingerprint, checkedAt: new Date().toISOString() }, null, 2),
  );

  if (args.failOnDrift && result.driftFound) return 2;
  return 0;
  } finally {
    // The bridge websocket would otherwise keep the process alive after the report.
    bridge?.close();
  }
}

async function runWebhookCommand(args: CliArgs): Promise<number> {
  const config: DriftConfig = loadConfig(args.config ?? "elf.config.json");
  const figmaToken = process.env[config.figma.apiTokenEnv];
  if (!figmaToken) {
    throw new Error(`Figma API token not found. Set the ${config.figma.apiTokenEnv} environment variable.`);
  }

  const passcodeEnv = config.webhook?.passcodeEnv ?? DEFAULT_PASSCODE_ENV;
  const endpoint = args.endpoint ?? config.webhook?.endpoint ?? "";

  if (args.list) {
    const webhooks = await listWebhooks(config.figma.fileKey, figmaToken);
    if (webhooks.length === 0) {
      console.log("No webhooks registered for this file.");
    } else {
      console.log(`Webhooks for file ${config.figma.fileKey}:`);
      for (const webhook of webhooks) {
        console.log(`  ${webhook.event_type}\t${webhook.status ?? "?"}\t${webhook.endpoint}\t(${webhook.id})`);
      }
    }
    return 0;
  }

  if (args.test) {
    if (!endpoint) {
      throw new Error("No webhook endpoint configured: pass --endpoint <url> or set webhook.endpoint in elf.config.json.");
    }
    const passcode = process.env[passcodeEnv];
    if (!passcode) {
      throw new Error(`Passcode not found. Set the ${passcodeEnv} environment variable (must match the worker's FIGMA_PASSCODE secret).`);
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "FILE_VARIABLES_UPDATE",
        file_key: config.figma.fileKey,
        file_name: "elf-tokens test",
        passcode,
        timestamp: new Date().toISOString(),
      }),
    });
    const body = (await response.text().catch(() => "")).slice(0, 300);
    console.log(`Test delivery: ${response.status} ${body}`);
    if (!response.ok) {
      console.log("Check the worker's FIGMA_PASSCODE secret and GITHUB_TOKEN/GITHUB_REPO configuration.");
    } else {
      let forwarded: boolean | undefined;
      try {
        forwarded = (JSON.parse(body) as { forwarded?: boolean }).forwarded;
      } catch {
        forwarded = undefined;
      }
      console.log(forwarded === false
        ? "Accepted (Slack-only worker: no GITHUB_REPO/GITHUB_TOKEN configured) — a ping should appear in Slack if SLACK_WEBHOOK_URL is set."
        : "If the worker forwarded it, a drift check run should appear on the repo's Actions tab, and a Slack ping if SLACK_WEBHOOK_URL is set.");
    }
    return response.ok ? 0 : 1;
  }

  if (!endpoint) {
    throw new Error("No webhook endpoint configured: pass --endpoint <url> or set webhook.endpoint in elf.config.json.");
  }

  const passcode = process.env[passcodeEnv];
  const generated = !passcode;
  const finalPasscode = passcode ?? generatePasscode();
  if (finalPasscode.length < 8) {
    throw new Error(`Passcode is too short (Figma requires at least 8 characters).`);
  }

  const results = await registerWebhooks(config, figmaToken, endpoint, finalPasscode);
  console.log(`Registered webhooks for file ${config.figma.fileKey} → ${endpoint}`);
  for (const line of results) {
    console.log(`  ${line}`);
  }
  console.log(generated
    ? `Passcode: ${finalPasscode} (generated — set it as the worker's FIGMA_PASSCODE secret)`
    : "Passcode: from environment");
  console.log("Done. Token edits in Figma will now trigger the figma-drift-watch workflow.");

  return 0;
}

function createLiveApi(config: DriftConfig): FigmaApi {
  const token = process.env[config.figma.apiTokenEnv];
  if (!token) {
    throw new Error(
      `Figma API token not found. Set the ${config.figma.apiTokenEnv} environment variable ` +
        `(add it as a GitHub secret with the same name in CI).`,
    );
  }
  return new FigmaClient(token);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`Drift check failed: ${(error as Error).message}`);
    process.exitCode = 1;
  });
