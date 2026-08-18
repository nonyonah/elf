#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { detectCodebaseSource, parseCodebaseTokens } from "./codebase/index.js";
import { loadConfig } from "./config.js";
import { diffTokens, type DriftResult } from "./diff.js";
import { FigmaClient, type FigmaApi } from "./figma/client.js";
import { fetchStyles } from "./figma/styles.js";
import { fetchVariables } from "./figma/variables.js";
import { buildReport } from "./report.js";
import { buildSampleConfig, createSampleFigmaApi, type SampleFormat } from "./sample.js";
import type { DriftConfig, FigmaSource, Token } from "./types.js";
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
  --help                 Show this help

Requires the Figma API token in the environment variable named by
figma.apiTokenEnv in the config (default: FIGMA_API_TOKEN).
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

  const api: FigmaApi = args.sample ? createSampleFigmaApi() : createLiveApi(config);

  const [figmaTokens, figmaSource] = await fetchFigmaTokens(api, config);

  const codebaseSource =
    config.codebase.source === "auto" ? detectCodebaseSource(config.codebase.path) : config.codebase.source;
  const codeTokens = await parseCodebaseTokens(codebaseSource, config.codebase.path);

  const result = diffTokens(figmaTokens, codeTokens, config.nameMapping);

  const report = buildReport(result, {
    fileKey: config.figma.fileKey,
    figmaSource,
    codebaseSource,
    figmaTokenCount: figmaTokens.length,
    codeTokenCount: codeTokens.length,
    checkedAt: new Date().toISOString(),
  });

  const outPath = resolve(args.out ?? "drift-report.md");
  const statusPath = join(dirname(outPath), "drift-status.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${report}\n`);
  writeFileSync(statusPath, JSON.stringify({ ...statusPayload(result), checkedAt: new Date().toISOString() }, null, 2));

  console.log(report);
  console.log(`\nReport written to ${outPath} (${result.driftFound ? "drift found" : "clean"}).`);
  console.log("Exit code reflects drift only with --fail-on-drift.");

  if (args.failOnDrift && result.driftFound) return 2;
  return 0;
}

function statusPayload(result: DriftResult): Record<string, unknown> {
  return {
    driftFound: result.driftFound,
    valueMismatches: result.valueMismatches.length,
    missingInCode: result.missingInCode.length,
    missingInFigma: result.missingInFigma.length,
  };
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
    console.log(response.ok ? "If the worker forwarded it, a drift check run should appear on the repo's Actions tab." : "Check the worker's FIGMA_PASSCODE secret and GITHUB_TOKEN/GITHUB_REPO configuration.");
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

async function fetchFigmaTokens(
  api: FigmaApi,
  config: DriftConfig,
): Promise<[Token[], FigmaSource]> {
  const { fileKey } = config.figma;

  if (config.figma.source === "variables") {
    return [await fetchVariables(api, fileKey, config.modeName), "variables"];
  }
  if (config.figma.source === "styles") {
    return [await fetchStyles(api, fileKey, config.figma.teamId), "styles"];
  }

  const variableTokens = await fetchVariables(api, fileKey, config.modeName);
  if (variableTokens.length > 0) return [variableTokens, "variables"];
  return [await fetchStyles(api, fileKey, config.figma.teamId), "styles"];
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`Drift check failed: ${(error as Error).message}`);
    process.exitCode = 1;
  });
