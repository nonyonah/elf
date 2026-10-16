#!/usr/bin/env node
// Manual end-to-end drill for --notify: runs the CLI against bundled sample
// data with a local webhook capture server — no Figma token, no Slack needed.
// Not part of `npm test`; run with: npm run notify:drill
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "elf-notify-drill-"));
const out = join(scratch, "drift-report.md");
const statusPath = join(scratch, "drift-status.json");

const deliveries = [];
let mode = "ok";

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (mode === "fail") {
      res.writeHead(500).end("nope");
      return;
    }
    try {
      deliveries.push(JSON.parse(body));
      res.writeHead(204).end();
    } catch {
      res.writeHead(400).end();
    }
  });
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const webhook = `http://127.0.0.1:${server.address().port}/hook`;

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail.trim().split("\n").slice(-4).join(" | ")}`}`);
  if (!ok) failures++;
};

// Async spawn so this process's event loop stays free to serve the webhook.
const run = (args, env = {}) =>
  new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: ROOT,
      env: { ...process.env, ELF_NOTIFY_WEBHOOK: "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });

const fingerprint = () => {
  try {
    return JSON.parse(readFileSync(statusPath, "utf8")).fingerprint ?? null;
  } catch {
    return null;
  }
};

try {
  console.log(`Drill webhook: ${webhook}\n`);

  // 1. First report with drift → one delivery with the full summary.
  let r = await run(["--sample", "--notify", "--out", out], { ELF_NOTIFY_WEBHOOK: webhook });
  check("first report with drift posts an alert", r.status === 0 && deliveries.length === 1, r.stdout + r.stderr);
  const payload = deliveries[0] ?? {};
  check("payload is Slack JSON with a text fallback and blocks", typeof payload.text === "string" && Array.isArray(payload.blocks));
  const section = payload.blocks?.[1]?.text?.text ?? "";
  check("payload carries the drift counts and items", /Value mismatches: 1/.test(section) && /Missing in code: 1/.test(section) && /• missing in code:/.test(section));

  // 2. Same state again → deduped.
  r = await run(["--sample", "--notify", "--out", out], { ELF_NOTIFY_WEBHOOK: webhook });
  check("unchanged state is deduped", r.status === 0 && deliveries.length === 1 && /unchanged/.test(r.stdout));

  // 3. A different drift state (styles fixtures) → posts again.
  r = await run(["--sample", "styles", "--notify", "--out", out], { ELF_NOTIFY_WEBHOOK: webhook });
  check("a changed drift state posts again", r.status === 0 && deliveries.length === 2 && /Notification posted/.test(r.stdout));

  // 4. Webhook down → warning, exit stays 0, state kept retryable.
  mode = "fail";
  rmSync(statusPath, { force: true });
  r = await run(["--sample", "--notify", "--out", out], { ELF_NOTIFY_WEBHOOK: webhook });
  check("a failing webhook warns without failing the run", r.status === 0 && /Notification failed/.test(r.stdout + r.stderr));
  check("failed post keeps the state retryable", fingerprint() === "");

  // 5. Webhook back up → next run retries.
  mode = "ok";
  r = await run(["--sample", "--notify", "--out", out], { ELF_NOTIFY_WEBHOOK: webhook });
  check("the next run retries and posts", r.status === 0 && deliveries.length === 3 && /Notification posted/.test(r.stdout));
  const finalFp = fingerprint();
  check("state advances after a successful post", typeof finalFp === "string" && finalFp.length === 16);

  // 6. Webhook env missing → fail fast with a clear message.
  r = await run(["--sample", "--notify", "--out", out]);
  check("missing webhook env fails fast", r.status === 1 && /Webhook URL not found/.test(r.stdout + r.stderr));
} finally {
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll notify drill checks passed" : `\n${failures} notify drill check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
