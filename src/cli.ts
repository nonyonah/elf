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

const USAGE = `elf-tokens — design token drift checker

Compares Figma design tokens against the tokens in your codebase and
reports value mismatches and missing tokens on either side.

Usage:
  elf-tokens [options]
  npm run check-drift [options]

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

interface CliArgs {
  help: boolean;
  sample: string | boolean;
  config?: string;
  out?: string;
  failOnDrift?: boolean;
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
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
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
