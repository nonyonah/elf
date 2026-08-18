import worker from "./index.js";

const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  return new Response(null, { status: 204 });
};

const env = { FIGMA_PASSCODE: "testpasscode123", GITHUB_REPO: "nonyonah/elf", GITHUB_TOKEN: "ghp_fake" };

const post = (body) =>
  new Request("https://bridge.example.workers.dev/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const get = (query = "") => new Request(`https://bridge.example.workers.dev/${query}`, { method: "GET" });

const base64 = (text) => Buffer.from(text).toString("base64");

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failures++;
};

const contents = (name, text, ref = "drift-data") =>
  new Response(JSON.stringify({ content: base64(text), ref }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

// --- POST webhook route ---

globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  return new Response(null, { status: 204 });
};

let r = await worker.fetch(post({ event_type: "PING", passcode: "testpasscode123" }), env);
check("PING returns 200 and is not forwarded", r.status === 200 && calls.length === 0);

r = await worker.fetch(post({ event_type: "FILE_VARIABLES_UPDATE", passcode: "wrong" }), env);
check("bad passcode returns 403", r.status === 403 && calls.length === 0);

r = await worker.fetch(post({ event_type: "FILE_VARIABLES_UPDATE", file_key: "abc123", file_name: "Tokens", passcode: "testpasscode123" }), env);
const call = calls[0];
check("event forwards to dispatches", r.status === 200 && call.url === "https://api.github.com/repos/nonyonah/elf/dispatches");
check("auth header present", call.init.headers.Authorization === "Bearer ghp_fake");
check("user-agent header present", call.init.headers["User-Agent"] === "elf-tokens-bridge/1.0");
const body = JSON.parse(call.init.body);
check(
  "event_type + client_payload shape",
  body.event_type === "figma-tokens-updated" &&
    body.client_payload.fileKey === "abc123" &&
    body.client_payload.passcode === "testpasscode123",
);

// --- GET status route ---

r = await worker.fetch(get("?fileKey=abc&passcode=wrong"), env);
check("GET bad passcode returns 403", r.status === 403);

r = await worker.fetch(get("?passcode=testpasscode123"), env);
check("GET missing fileKey returns 400", r.status === 400);

globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  if (String(url).includes("drift-status.json")) {
    return contents("drift-status.json", JSON.stringify({
      checkedAt: "2026-01-01T00:00:00.000Z",
      driftFound: true,
      valueMismatches: 2,
      missingInCode: 1,
      missingInFigma: 0,
    }));
  }
  if (String(url).includes("drift-report.md")) {
    return contents("drift-report.md", "# report body");
  }
  return new Response(null, { status: 404 });
};

r = await worker.fetch(get("?fileKey=abc123&passcode=testpasscode123"), env);
const statusData = await r.json();
check("GET returns 200 with parsed data", r.status === 200 && statusData.ok === true);
check("GET data carries fileKey, repo, counts, report", statusData.fileKey === "abc123" && statusData.repo === "nonyonah/elf" && statusData.driftFound === true && statusData.report === "# report body");
const contentCall = calls.find((c) => String(c.url).includes("drift-status.json"));
check("GET fetches from drift-data branch", String(contentCall.url).endsWith("?ref=drift-data"));

globalThis.fetch = async () => new Response(null, { status: 404 });
r = await worker.fetch(get("?fileKey=abc123&passcode=testpasscode123"), env);
const noData = await r.json();
check("GET no data yet returns clear error", r.status === 200 && noData.ok === false && /no drift data yet/.test(noData.error));

// --- misc ---

r = await worker.fetch(get(), env);
check("GET without passcode returns 403", r.status === 403);

r = await worker.fetch(new Request("https://bridge.example.workers.dev/", { method: "DELETE" }), env);
check("non-GET/POST returns 405", r.status === 405);

r = await worker.fetch(new Request("https://bridge.example.workers.dev/", { method: "OPTIONS" }), env);
check("OPTIONS preflight returns 204 with CORS", r.status === 204 && r.headers.get("Access-Control-Allow-Origin") === "*");

globalThis.fetch = async () => new Response("forbidden", { status: 401 });
r = await worker.fetch(post({ event_type: "FILE_VARIABLES_UPDATE", file_key: "abc", passcode: "testpasscode123" }), env);
check("github 401 becomes 502", r.status === 502);

console.log(failures === 0 ? "\nAll worker checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
