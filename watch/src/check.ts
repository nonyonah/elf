import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CheckResult } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const LOCAL_ELF_BIN = resolve(here, "../../bin/elf-tokens.js");
const STATUS_FILE = "drift-status.json";
const REPORT_FILE = "drift-report.md";

/**
 * Runs the normal elf check as a child process so watcher state never bleeds
 * into the check's bridge/config caches. The full report is written to
 * `drift-report.md`; only the status summary is read back.
 */
export async function runElfCheck(
  configPath: string,
  reportDir: string,
  notify = false,
): Promise<CheckResult> {
  const absoluteConfigPath = configPath ? resolve(configPath) : "";
  if (!absoluteConfigPath || !existsSync(absoluteConfigPath)) {
    return {
      status: "failed",
      message: "No elf.config.json found — pass --check-config or add one to the project.",
    };
  }

  const outPath = resolve(reportDir, REPORT_FILE);
  mkdirSync(dirname(outPath), { recursive: true });

  return new Promise<CheckResult>((resolveResult) => {
    const local = existsSync(LOCAL_ELF_BIN);
    const command = local ? process.execPath : (process.env.ELF_TOKENS_BIN ?? "elf-tokens");
    const args = local
      ? [LOCAL_ELF_BIN, "check", "--config", absoluteConfigPath, "--out", outPath, "--fail-on-drift"]
      : ["check", "--config", absoluteConfigPath, "--out", outPath, "--fail-on-drift"];
    if (notify) args.push("--notify");
    const child = spawn(command, args, {
      cwd: dirname(absoluteConfigPath),
      timeout: 60_000,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      resolveResult({ status: "failed", message: `Could not start elf check: ${error.message}` });
    });

    child.on("close", (code) => {
      const notified = /Notification posted/.test(stdout);
      const notificationError = stderr.split(/\r?\n/).find(line => /Notification failed:/.test(line))?.trim();
      if (code === 0) {
        resolveResult({ status: "clean", notified, notificationError });
        return;
      }
      if (code === 2) {
        resolveResult({
          status: "drift",
          total: readTotal(resolve(reportDir, STATUS_FILE)),
          notified,
          notificationError,
        });
        return;
      }
      resolveResult({
        status: "failed",
        message: compactError(stderr || stdout) || `elf check exited with code ${code ?? "?"}`,
      });
    });
  });
}

/** Keep one actionable line; the full report is in drift-report.md. */
function compactError(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^Skipped \d+/.test(line));
  const detail = lines.slice(-3).join(" ");
  const clipped = detail.length > 360 ? `${detail.slice(0, 357)}...` : detail;
  if (/Cannot find module/.test(clipped) && /tailwind\.config/.test(clipped)) {
    return `${clipped} Pass --check-config <path> or fix "codebase.path".`;
  }
  return clipped;
}

function readTotal(statusPath: string): number | undefined {
  try {
    const status = JSON.parse(readFileSync(statusPath, "utf8")) as Record<string, unknown>;
    const keys = [
      "valueMismatches",
      "missingInCode",
      "missingInFigma",
      "componentsOutOfDate",
      "componentsChangedInFigma",
      "componentsInCodeNotInFigma",
      "componentsInFigmaNotInCode",
      "deprecationOverdue",
    ];
    return keys.reduce((total, key) => total + (typeof status[key] === "number" ? status[key] : 0), 0);
  } catch {
    return undefined;
  }
}
