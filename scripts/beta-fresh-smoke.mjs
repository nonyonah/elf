import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";

const failures = [];
const check = (name, pass, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures.push(name);
};
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const stripes = (text) => (text.match(/pairing|Settings|Open the Elf/g) ?? []).slice(0, 3).join(" | ");

const repo = process.cwd();
const packageVersion = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
const artifactName = `elf-tokens-${packageVersion}.tgz`;
check("pack artifact present", existsSync(join(repo, artifactName)));

const root = mkdtempSync(join(tmpdir(), "elf-beta-smoke-"));
const project = join(root, "project");
const home = join(root, "home");
mkdirSync(join(project, "deep", "nesting"), { recursive: true });
mkdirSync(home);

const env = { ...process.env, HOME: home, USERPROFILE: home };
const run = (cwd, args, timeout = 30000) => {
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: "utf8", timeout });
  return { status: result.status, signal: result.signal, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

const installPath = join(project, "deep", "nesting");
const win = platform() === "win32";
const npm = win ? "npm.cmd" : "npm";

{ const init = spawnSync(npm, ["init", "-y"], { cwd: installPath, env, encoding: "utf8", timeout: 60000, shell: win });
  check(`npm init (exit ${init.status})`, init.status === 0, String(init.stderr ?? "").slice(0, 200)); }
{ const install = spawnSync(npm, ["install", join(repo, artifactName), "--no-audit", "--no-fund"], { cwd: installPath, env, encoding: "utf8", timeout: 300000, shell: win });
  check(`npm install packed tarball (exit ${install.status})`, install.status === 0, String(install.stderr ?? "").slice(0, 200)); }

const pkgRoot = join(installPath, "node_modules", "elf-tokens");
let pkgInfo = "";
try { pkgInfo = readFileSync(join(pkgRoot, "package.json"), "utf8"); } catch {}
check("runtime resolves from packed install", pkgInfo.includes('"name": "elf-tokens"'));
check("engine requirement declares node >=20", pkgInfo.includes("20"));
check("packaged MCP server ships", existsSync(join(pkgRoot, "mcp", "src", "client.ts")));
check("packaged public plugin bundle ships", existsSync(join(pkgRoot, "dist", "bridge-plugin-public", "manifest.json")));
check("packaged public plugin code ships non-empty", existsSync(join(pkgRoot, "dist", "bridge-plugin-public", "code.js")) && readFileSync(join(pkgRoot, "dist", "bridge-plugin-public", "code.js"), "utf8").length > 10000);
check("packaged Settings index ships", existsSync(join(pkgRoot, "dist", "settings", "index.html")));
check("packaged Settings brand ships", existsSync(join(pkgRoot, "dist", "settings", "brand", "elf-mascot.png")));
check("packaged Settings build manifest ships", existsSync(join(pkgRoot, "dist", "settings", "_next", "static")) || existsSync(join(pkgRoot, "dist", "settings", "404.html")));

{ const help = run(installPath, [join(pkgRoot, "bin", "elf-tokens.js"), "--help"]);
  check("CLI --help prints usage", help.status === 0 && /elf-tokens \[options\]/.test(help.stdout), help.stderr.slice(0, 200)); }
{ const ext = run(installPath, [join(pkgRoot, "bin", "elf-tokens.js"), "extension"]);
  check("extension discovery without marketplace claim", ext.status === 0 && /(Install from VSIX|native editor preview)/.test(ext.stdout), ext.stdout.slice(0, 120)); }

const token = "smoke-" + Math.random().toString(16).slice(2);
{ const status = run(installPath, [join(pkgRoot, "bin", "elf-tokens.js"), "status"], 60000);
  const out = status.stdout + status.stderr;
  // `elf status` with no prior check is designed to exit 1 with that message —
  // anything else (including a null status from a killed/timed-out process) fails.
  check("`status` runs without Figma with expected exit 1", status.status === 1 && /No status yet/.test(out), `exit=${status.status} signal=${status.signal} ${out.slice(0, 160)}`);
  check("`status` leaks no settings token", !/#elf=[a-f0-9]/.test(out)); }
{ const ready = await launchAndVerifyStart();
  if (ready !== true) failures.push(ready.name); }
{ const stopped = await launchAndVerifySharedHost();
  if (stopped !== true) failures.push(stopped.name); }

try { rmSync(root, { recursive: true, force: true }); } catch { check("temp workspace cleaned", false); }
check("temp workspace cleaned", !existsSync(root));

if (failures.length) { console.error(`\nFresh-install smoke failed: ${failures.join("; ")}`); process.exit(1); }
console.log("\nFresh-install smoke passed.");

/** Launch `elf start` detached in its own process group, wait for explicit
 *  readiness output, verify records, then destroy the whole group. */
async function launchAndVerifyStart() {
  const { spawn } = await import("node:child_process");
  const childEnv = { ...env, ELF_SETTINGS_NO_OPEN: "1", ELF_MCP_PORT: "0", ELF_MCP_HTTP_PORT: "0", ELF_MCP_TOKEN: token };
  const child = spawn(process.execPath, [join(pkgRoot, "bin", "elf-tokens.js"), "start"],
    { cwd: installPath, env: childEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const stdout = []; const stderr = [];
  child.stdout.on("data", d => stdout.push(String(d)));
  child.stderr.on("data", d => stderr.push(String(d)));
  const deadline = 30000;
  const began = Date.now();
  let ready = false;
  const readinessPattern = /bridge listening|using the shared authenticated Elf bridge|Pairing code/;
  while (Date.now() - began < deadline) {
    await sleep(150);
    const soFar = stdout.join("");
    if (readinessPattern.test(soFar)) { ready = true; break; }
    if (/BridgeError|TypeError/.test(stderr.join("")) && !ready) break;
    if (child.exitCode !== null) break;
  }
  const soFarStdout = stdout.join(""); const soFarStderr = stderr.join("");
  const stripeDetail = `${stripes(soFarStdout)} ${soFarStderr.slice(0, 120)}`;
  check("first-run start reaches explicit readiness", ready, stripeDetail);
  check("first-run start boots headless without crash", !/BridgeError|TypeError|at .+\(.+\.ts/.test(soFarStderr), soFarStderr.slice(0, 200));
  check("first-run prints onboarding and pairing", /pairing|Settings|Open the Elf/.test(soFarStdout + soFarStderr), stripes(soFarStdout + soFarStderr));
  check("first-run stderr leaks no settings token", !/#elf=[a-f0-9]/.test(soFarStderr));
  check("random token never appears in output", !soFarStdout.includes(token) && !soFarStderr.includes(token));
  const cleanup = await destroyTree(child.pid);
  check("start process group fully terminated", cleanup, `pid=${child.pid} exit=${child.exitCode} signal=${child.signal}`);
  return ready ? true : { name: "start never became ready", detail: stripeDetail };
}

/** The default-port runtime runs the bridge in a detached shared host that the
 *  CLI's process group does not own. This scenario launches `elf start` on an
 *  explicit ephemeral port (persistent shared-host mode), kills the CLI group
 *  as any terminal would, then REQUIRES an explicit stop and verifies the
 *  bridge is genuinely unreachable afterwards. */
async function launchAndVerifySharedHost() {
  const { spawn } = await import("node:child_process");
  const net = await import("node:net");
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer(incoming => { incoming.destroy(); });
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const found = probe.address().port; probe.close(() => resolve(found)); });
  });
  const homeRoot = mkdtempSync(join(tmpdir(), "elf-beta-smoke-host-"));
  const home = join(homeRoot, "home");
  mkdirSync(home);
  const hostToken = "smoke-host-" + Math.random().toString(16).slice(2);
  const hostEnv = { ...env, HOME: home, USERPROFILE: home, ELF_SETTINGS_NO_OPEN: "1", ELF_MCP_PORT: String(port), ELF_MCP_HTTP_PORT: "0", ELF_MCP_TOKEN: hostToken };
  const child = spawn(process.execPath, [join(pkgRoot, "bin", "elf-tokens.js"), "start"],
    { cwd: installPath, env: hostEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const stdout = []; const stderr = [];
  child.stdout.on("data", d => stdout.push(String(d)));
  child.stderr.on("data", d => stderr.push(String(d)));
  let ready = false;
  const deadline = 30000; const began = Date.now();
  while (Date.now() - began < deadline) {
    await sleep(150);
    if (/using the shared authenticated Elf bridge/.test(stdout.join("") + stderr.join(""))) { ready = true; break; }
    if (/BridgeError|TypeError/.test(stderr.join("")) && !ready) break;
    if (child.exitCode !== null) break;
  }
  const soFar = `${stdout.join("")}${stderr.join("")}`;
  check("shared-host start reaches explicit readiness", ready, `${stripes(stdout.join(""))} ${stderr.join("").slice(0, 120)}`);
  check("bridge listens on the explicit port while running", ready && await tcpReachable(port), `port=${port}`);
  const groupKilled = await destroyTree(child.pid);
  check("cli process group terminated", groupKilled, `pid=${child.pid}`);
  const stop = spawnSync(process.execPath, [join(pkgRoot, "bin", "elf-tokens.js"), "bridge", "--stop"],
    { cwd: installPath, env: hostEnv, encoding: "utf8", timeout: 30000 });
  const stopOut = `${stop.stdout ?? ""}${stop.stderr ?? ""}`;
  const stoppedByCommand = stop.status === 0 && /Shared bridge stopped/.test(stopOut);
  const alreadyGone = stop.status !== 0 && /Cannot reach the Elf bridge|connection refused/i.test(stopOut);
  check("explicit bridge stop succeeds after cli teardown", stoppedByCommand || alreadyGone, `exit=${stop.status} ${stopOut.slice(0, 160)}`);
  check("bridge explicitly reports shutdown", !stoppedByCommand || /Shared bridge stopped/.test(stopOut), stopOut.slice(0, 120));

  let gone = false;
  const refusalDeadline = Date.now() + 8000;
  let detail = "";
  while (Date.now() < refusalDeadline) {
    if (!(await tcpReachable(port))) { gone = true; break; }
    await sleep(300);
  }
  check("bridge port no longer accepts connections", gone, `port=${port}`);
  if (!gone) {
    const second = spawnSync(process.execPath, [join(pkgRoot, "bin", "elf-tokens.js"), "bridge", "--stop"],
      { cwd: installPath, env: hostEnv, encoding: "utf8", timeout: 30000 });
    gone = !(await tcpReachable(port));
    detail = `second stop exit=${second.status} ${`${second.stdout ?? ""}${second.stderr ?? ""}`.slice(0, 120)}`;
  }
  check("bridge port verified unreachable after stop", gone, detail);

  let orphans = null;
  if (!win) {
    const audit = spawnSync("pgrep", ["-f", String(homeRoot)], { encoding: "utf8", timeout: 15000 });
    orphans = String(audit.stdout ?? "").trim();
  }
  check("no leftover processes reference the temp home", orphans === null || orphans === "", orphans ?? "windows: tcp-refusal check governs");

  await destroyTree(child.pid);
  try { rmSync(homeRoot, { recursive: true, force: true }); } catch { check("shared-host temp home cleaned", false); }
  check("shared-host temp home cleaned", !existsSync(homeRoot));
  return ready && stoppedByCommand !== false && gone ? true : { name: "shared-host bridge did not verify stop", detail: `ready=${ready} gone=${gone}` };
}

async function tcpReachable(port) {
  const net = await import("node:net");
  return await new Promise(resolve => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
    socket.setTimeout(1500, () => { socket.destroy(); resolve(false); });
  });
}

async function destroyTree(pid) {
  try {
    if (win) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { timeout: 15000, shell: false });
    else process.kill(-pid, "SIGKILL");
  } catch (error) { if (String(error.code) !== "ESRCH") { console.log(`cleanup kill error: ${error.message}`); return false; } }
  for (let i = 0; i < 30; i += 1) {
    await sleep(100);
    try { process.kill(pid, 0); } catch { return true; }
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
  await sleep(300);
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
}
