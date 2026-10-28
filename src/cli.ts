#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { detectCodebaseSource, parseProjectTokens } from "./codebase/index.js";
import { diffComponents } from "./components.js";
import { findConfigPath, loadConfig } from "./config.js";
import { loadSettingsEnv } from "./env.js";
import { applyDeprecations, applyIntentionalDifferences } from "./core/deprecations.js";
import { diffTokens, hasDrift, type DriftResult } from "./core/diff.js";
import { connectBridge, type BridgeCaller } from "./figma/bridge.js";
import { FigmaClient, type FigmaApi } from "./figma/client.js";
import { fetchFigmaTokens } from "./figma/source.js";
import {
  notificationItems,
  buildNotifyMessage,
  decideNotification,
  driftFingerprint,
  postNotification,
  readNotifyState,
  resolveNotifyWebhook,
  resolveReportUrl,
  writeNotifyState,
  type NotifyState,
  type ResolvedNotifyWebhook,
} from "./notify.js";
import { buildReport, buildStatusPayload, type ReportMeta } from "./core/report.js";
import { buildSampleConfig, createSampleFigmaApi, type SampleFormat } from "./sample.js";
import type { DriftConfig, Token } from "./core/types.js";
import { buildCodePushPayload, collectComponentSnapshot, postCodeSnapshot, readGitInfo } from "./push.js";
import { applyRemoteConfig, fetchRemoteConfig } from "./remote-config.js";
import {
  DEFAULT_PASSCODE_ENV,
  generatePasscode,
  listWebhooks,
  registerWebhooks,
} from "./webhook.js";
import {
  connectSlackOAuth,
  connectSlackManual,
  disconnectSlack,
  readSlackWebhook,
  SLACK_WEBHOOK_FILE,
  maskWebhookUrl,
} from "./slack.js";
import { runSettingsServer } from "./settings.js";

const USAGE = `elf-tokens — design token drift checker

Compares Figma design tokens against the tokens in your codebase and
reports value mismatches and missing tokens on either side.

Usage:
  elf-tokens [options]
  elf-tokens push [options]
  elf-tokens status [options]
  elf-tokens webhook [options]
  elf-tokens connect slack [options]
  elf-tokens disconnect slack
  elf-tokens settings
  npm run check-drift [options]

The npm package installs both \`elf\` and \`elf-tokens\` — same CLI, either name.

Commands:
  extension            Discover the native VS Code extension and preview setup.
  start                Open setup and monitor this project (default with no arguments).
  mcp                  Run the MCP adapter for coding assistants (stdio by default).
  bridge               Start the local Figma bridge and print a pairing code.
  sync                 Create/update Figma tokens and components from batch config.
  watch                Watch local sources, sync changes, and check drift.
  push                 Send a code snapshot (tokens, components, drift) to the
                       elf console dashboard. Needs "dashboard.url" in the
                       config (or --url) and the ELF_DASHBOARD_TOKEN variable.
  status               Show the last check's result from drift-status.json
                       (no Figma or dashboard access needed).
  webhook              Register Figma webhooks that notify the repo
                       when tokens change in the file (see --help with
                       the webhook command for details).
  connect slack        Connect a Slack incoming webhook via OAuth (PKCE, no backend)
                       or pass --webhook-url to store a manual URL.
  disconnect slack     Remove the stored Slack webhook.
  settings             Open a local web page to configure Slack notifications.

Options:
  --config <path>        Path to the config file (default: elf.config.json)
  --out <path>           Where to write the markdown report (default: drift-report.md)
  --sample [format]      Run against bundled sample data, no Figma token needed.
                         Optional format: variables | styles | tailwind | css | tokens-json
  --fail-on-drift        Exit with code 2 when drift is found (off by default)
  --notify               Post a summary using "notify.webhookEnv", or the Slack
                         connection saved by \`elf connect slack\` / \`elf settings\`.
                         Sends only when the drift state changed since the last run.
  --json                 With status: print drift-status.json verbatim
  --help                 Show this help

Push options:
  --dry-run              Print the exact JSON payload and exit 0 without sending
  --url <url>            Dashboard base URL (default: dashboard.url in the config)
                         Token: ELF_DASHBOARD_TOKEN environment variable, never
                         stored in the config.

Connect slack options:
  --webhook-url <url>    Store a manual Slack incoming webhook URL instead of
                         running the OAuth flow. The URL is never printed in full.

Requires the Figma API token in the environment variable named by
figma.apiTokenEnv in the config (default: FIGMA_API_TOKEN). The notify
webhook URL comes from notify.webhookEnv or the stored Slack connection —
it is never stored in the config file.
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
  dryRun?: boolean;
  json?: boolean;
  url?: string;
  endpoint?: string;
  list?: boolean;
  test?: boolean;
  webhookUrl?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false, sample: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--fail-on-drift") {
      args.failOnDrift = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
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
  const command = rawArgs[0] && !rawArgs[0].startsWith("-") ? rawArgs[0] : "";
  const hasSubcommand = command !== "" && rawArgs[1] !== undefined && !rawArgs[1].startsWith("-");
  const subcommand = hasSubcommand ? rawArgs[1] : "";
  const rest = hasSubcommand ? rawArgs.slice(2) : command === "" ? rawArgs : rawArgs.slice(1);
  const args = parseArgs(rest);
  if (args.help) {
    console.log(command === "webhook" ? WEBHOOK_USAGE : USAGE);
    return 0;
  }
  if (command === "webhook") {
    return runWebhookCommand(args);
  }
  if (command === "status") {
    return runStatusCommand(args);
  }
  if (command === "connect" && subcommand === "slack") {
    return runConnectSlackCommand(args);
  }
  if (command === "disconnect" && subcommand === "slack") {
    return runDisconnectSlackCommand(args);
  }
  if (command === "settings") {
    return runSettingsCommand(args);
  }

  const configPath = args.config ?? "elf.config.json";
  const baseConfig: DriftConfig = args.sample
    ? buildSampleConfig(typeof args.sample === "string" ? (args.sample as SampleFormat) : undefined)
    : loadConfig(configPath);
  const config = args.sample ? baseConfig : await mergeDashboardConfig(baseConfig, args);

  let api: FigmaApi | null = null;
  const restApi = (): FigmaApi => {
    api ??= args.sample ? createSampleFigmaApi() : createLiveApi(config);
    return api;
  };

  let bridge: BridgeCaller | null = null;
  const getBridge = async (): Promise<BridgeCaller> => {
    bridge ??= await connectBridge(config.figma.fileKey, config.figma.authorization);
    return bridge;
  };

  try {
    if (command === "push") {
      return await runPushCommand(args, config, restApi, getBridge);
    }

    let notifyWebhook: ResolvedNotifyWebhook | null = null;
    if (args.notify) {
      if (!config.notify) {
        throw new Error('--notify needs a "notify" section in the config, e.g. {"notify": {"webhookEnv": "SLACK_WEBHOOK_URL"}}.');
      }
      notifyWebhook = resolveNotifyWebhook(config.notify, configPath);
      if (!notifyWebhook) {
        throw new Error(
          config.notify.format === "slack"
            ? `Webhook URL not found. Set the ${config.notify.webhookEnv} environment variable ` +
                "or connect Slack with `elf-tokens connect slack`."
            : `Webhook URL not found. Set the ${config.notify.webhookEnv} environment variable.`,
        );
      }
    }

    return await runDriftCheck(
      args,
      config,
      restApi,
      getBridge,
      notifyWebhook?.url ?? "",
      notifyWebhook?.source ?? "",
    );
  } finally {
    // The bridge websocket would otherwise keep the process alive after the report.
    (bridge as BridgeCaller | null)?.close();
  }
}

/**
 * The dashboard can own four config fields (CONTRACT.md's config endpoint):
 * deprecations, nameMapping, modeStrategy, modeName. Resolution order:
 * remote → cache (`.elf/config.remote.json`) → local. The check never fails
 * because the dashboard is unreachable; one stderr line says which was used.
 */
async function mergeDashboardConfig(config: DriftConfig, args: CliArgs): Promise<DriftConfig> {
  const url = args.url ?? config.dashboard?.url ?? "";
  const token = process.env.ELF_DASHBOARD_TOKEN ?? "";
  if (!url || !token) return config;
  try {
    const configDir = dirname(resolve(args.config ?? "elf.config.json"));
    const { config: remote, source } = await fetchRemoteConfig({
      url,
      token,
      cacheFile: join(configDir, ".elf", "config.remote.json"),
    });
    if (source === "remote") {
      console.error("Config: remote merge from the elf console applied over the local file.");
    } else if (source === "cache") {
      console.error("Config: dashboard unreachable — using the cached remote merge (last known).");
    } else {
      console.error("Config: local (the dashboard has no remote config yet).");
    }
    return applyRemoteConfig(config, remote);
  } catch (error) {
    console.error(`Config: local (remote merge failed: ${(error as Error).message}).`);
    return config;
  }
}

interface CheckOutput {
  figmaTokens: Token[];
  codeTokens: Token[];
  result: DriftResult;
  meta: ReportMeta;
  report: string;
}

/** The shared spine of `check` and `push`: fetch both sides, diff, render the report. */
async function runCheckCore(
  config: DriftConfig,
  restApi: () => FigmaApi,
  getBridge: () => Promise<BridgeCaller>,
): Promise<CheckOutput> {
  const { tokens: figmaTokens, source: figmaSource } = await fetchFigmaTokens(config, restApi, getBridge);

  const codebaseSource =
    config.codebase.source === "auto" ? detectCodebaseSource(config.codebase.path) : config.codebase.source;
  const codeTokens = await parseProjectTokens(config.codebase);

  let result = diffTokens(figmaTokens, codeTokens, config.nameMapping);

  let codeComponents: { name: string; codeKey: string; deprecated?: string }[] = [];
  if (config.components) {
    const componentDiff = await diffComponents(
      config.components.path,
      config.components.manifest,
      await getBridge(),
      config.components.files,
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
    [...config.deprecations, ...codeComponents.filter(item => item.deprecated !== undefined && !config.deprecations.some(rule => rule.type === "component" && (rule.name === item.name || rule.name === item.codeKey))).map(item => ({type: "component" as const, name: item.codeKey, reason: item.deprecated || "Marked @deprecated in source"}))],
    { codeTokens, codeComponents },
    new Date().toISOString().slice(0, 10),
  );

  result = applyIntentionalDifferences(result, config.intentionalDifferences, new Date().toISOString().slice(0, 10));

  const meta = {
    fileKey: config.figma.fileKey,
    figmaSource,
    codebaseSource,
    figmaTokenCount: figmaTokens.length,
    codeTokenCount: codeTokens.length,
    checkedAt: new Date().toISOString(),
  };
  const report = buildReport(result, meta);

  return { figmaTokens, codeTokens, result, meta, report };
}

async function runDriftCheck(
  args: CliArgs,
  config: DriftConfig,
  restApi: () => FigmaApi,
  getBridge: () => Promise<BridgeCaller>,
  webhookUrl: string,
  webhookSource: string,
): Promise<number> {
  const { result, meta, report } = await runCheckCore(config, restApi, getBridge);

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
    const statePath = notifyConfig.stateFile ?? join(dirname(statusPath), ".elf", "notify-state.json");
    const previousState = readNotifyState(statePath);
    const decision = decideNotification(previousState, result, notifyConfig.onlyOnChange !== false);
    const reportUrl = resolveReportUrl(config);
    const notifyMeta = {
      fileKey: meta.fileKey,
      figmaSource: meta.figmaSource,
      codebaseSource: meta.codebaseSource,
      checkedAt: meta.checkedAt,
      ...(reportUrl ? { url: reportUrl } : {}),
    };

    let posted = false;
    if (decision.send) {
      try {
        await postNotification(
          webhookUrl,
          notifyConfig.format,
          buildNotifyMessage(result, notifyMeta, notifyConfig.format, previousState),
        );
        posted = true;
        console.log(`Notification posted (via ${webhookSource || notifyConfig.webhookEnv}).`);
      } catch (error) {
        console.error(`Notification failed: ${(error as Error).message}`);
      }
    } else {
      console.log("No notification sent: drift state unchanged since the last run.");
    }

    // Keep the old state on a failed post so the next run retries.
    const persist: NotifyState | null =
      decision.send && !posted ? previousState : { fingerprint: decision.fingerprint, driftFound: result.driftFound, items: notificationItems(result) };
    if (persist) writeNotifyState(statePath, persist);
  }

  writeFileSync(
    statusPath,
    JSON.stringify({ ...buildStatusPayload(result), fingerprint: statusFingerprint, checkedAt: new Date().toISOString() }, null, 2),
  );

  if (args.failOnDrift && result.driftFound) return 2;
  return 0;
}

async function runPushCommand(
  args: CliArgs,
  config: DriftConfig,
  restApi: () => FigmaApi,
  getBridge: () => Promise<BridgeCaller>,
): Promise<number> {
  try {
    const url = args.url ?? config.dashboard?.url ?? "";
    const token = process.env.ELF_DASHBOARD_TOKEN ?? "";
    if (!args.dryRun) {
      if (!url) {
        throw new Error(
          'No dashboard URL. Add "dashboard": { "url": "https://<your-elf-console>" } to elf.config.json, or pass --url.',
        );
      }
      if (!token) {
        throw new Error(
          "Dashboard token not found. Set the ELF_DASHBOARD_TOKEN environment variable " +
            "(create one on the project's page in the elf console — it is never stored in the config).",
        );
      }
    }

    const { figmaTokens, codeTokens, result, meta, report } = await runCheckCore(config, restApi, getBridge);
    const git = readGitInfo(process.cwd());
    const payload = buildCodePushPayload({
      source: "cli",
      config,
      meta,
      figmaTokens,
      codeTokens,
      result,
      report,
      ...(config.components ? { components: collectComponentSnapshot(config.components) } : {}),
      ...(git ? { git } : {}),
    });

    if (args.dryRun) {
      console.log(JSON.stringify(payload, null, 2));
      console.error("Dry run: nothing was sent.");
      return 0;
    }

    const outcome = await postCodeSnapshot({ url, token, payload });
    if (outcome.ok) {
      const status = outcome.body?.status ?? "stored";
      console.log(`Pushed to ${url} — ${status}, ${result.driftFound ? "drift found" : "clean"}.`);
      return 0;
    }
    console.error(`Push failed after ${outcome.attempts} attempt(s): ${outcome.error}`);
    return 1;
  } catch (error) {
    console.error(`Push failed: ${(error as Error).message}`);
    return 1;
  }
}

async function runStatusCommand(args: CliArgs): Promise<number> {
  const outPath = resolve(args.out ?? "drift-report.md");
  const statusPath = join(dirname(outPath), "drift-status.json");

  let raw: string;
  try {
    raw = readFileSync(statusPath, "utf8");
  } catch {
    console.error(`No status yet: ${statusPath} not found. Run a check first (npx elf-tokens).`);
    return 1;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    console.error(`Unreadable status file: ${statusPath}`);
    return 1;
  }

  if (args.json) {
    console.log(raw.trim());
    return 0;
  }

  const driftCategories: [string, string][] = [
    ["valueMismatches", "Value mismatches"],
    ["missingInCode", "Missing in code"],
    ["missingInFigma", "Missing in Figma"],
    ["componentsOutOfDate", "Components out of date"],
    ["componentsChangedInFigma", "Components changed in Figma"],
    ["componentsInCodeNotInFigma", "Components in code, not in Figma"],
    ["componentsInFigmaNotInCode", "Components in Figma, not in code"],
    ["deprecationOverdue", "Deprecations overdue"],
  ];
  const noteCategories: [string, string][] = [
    ["deprecatedStillInCode", "Deprecated (still in code)"],
    ["safeToRemoveFromDeprecations", "Safe to remove from the deprecations list"],
  ];
  const count = (key: string): number => (typeof payload[key] === "number" ? (payload[key] as number) : 0);

  const driftFound = payload.driftFound === true;
  const checkedAt = typeof payload.checkedAt === "string" ? payload.checkedAt : "unknown";
  const fingerprint = typeof payload.fingerprint === "string" ? payload.fingerprint : "";

  console.log(`Drift status: ${driftFound ? "drift found" : "clean"}`);
  console.log(`Checked ${checkedAt}${fingerprint ? ` · fingerprint ${fingerprint}` : ""}`);
  if (driftFound) {
    let total = 0;
    for (const [key, label] of driftCategories) {
      total += count(key);
      if (count(key) > 0) console.log(`  ${label}: ${count(key)}`);
    }
    console.log(`  (${total} drift ${total === 1 ? "item" : "items"})`);
  }
  for (const [key, label] of noteCategories) {
    if (count(key) > 0) console.log(`  Note — ${label}: ${count(key)}`);
  }
  console.log(`Report: ${outPath}`);
  return 0;
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

async function runConnectSlackCommand(args: CliArgs): Promise<number> {
  const configPath = args.config ?? "elf.config.json";
  loadSettingsEnv(configPath);
  const config = loadConfig(configPath);

  // Argument parser stores kebab-case keys
  const webhookUrl = (args as unknown as Record<string, unknown>)['webhook-url'] as string | undefined;
  if (webhookUrl) {
    // Manual fallback path
    const info = await connectSlackManual(configPath, webhookUrl);
    console.log("Slack webhook stored manually.");
    console.log(`  Team: ${info.teamName}`);
    console.log(`  Channel: #${info.channel}`);
    console.log(`  Webhook: ${maskWebhookUrl(info.url)}`);
    console.log("The CLI will use this webhook for --notify when its env var is unset.");
    console.log("For live Figma pings, set the same URL as the worker's SLACK_WEBHOOK_URL secret.");
    return 0;
  }

  // PKCE OAuth flow
  try {
    const info = await connectSlackOAuth(configPath);
    console.log("Slack connected via OAuth.");
    console.log(`  Team: ${info.teamName}`);
    console.log(`  Channel: #${info.channel}`);
    console.log(`  Webhook: ${maskWebhookUrl(info.url)}`);
    console.log(`\nThe webhook URL is stored in ${SLACK_WEBHOOK_FILE} (gitignored).`);
    console.log("The CLI will use it for --notify when its env var is unset.");
    console.log("For live Figma pings, set the same URL as the worker's SLACK_WEBHOOK_URL secret.");
    console.log("Run \`elf-tokens settings\` to configure notification preferences.");
    return 0;
  } catch (error) {
    console.error(`Slack connection failed: ${(error as Error).message}`);
    return 1;
  }
}

async function runDisconnectSlackCommand(args: CliArgs): Promise<number> {
  const configPath = args.config ?? "elf.config.json";
  const removed = await disconnectSlack(configPath);
  if (removed) {
    console.log("Slack webhook removed.");
  } else {
    console.log("No Slack webhook was stored.");
  }
  return 0;
}

async function runSettingsCommand(args: CliArgs): Promise<number> {
  const configPath = args.config
    ? resolve(args.config)
    : findConfigPath();
  if (!configPath) {
    console.error(
      "No elf.config.json found in this folder or any parent folder. " +
        "Run this from your project, or pass --config <path>.",
    );
    return 1;
  }
  loadSettingsEnv(configPath);
  await runSettingsServer(configPath);
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
