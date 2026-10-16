const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

/** Best-effort Slack ping — a webhook URL here never blocks or fails the event. */
async function notifySlack(env, payload) {
  if (!env.SLACK_WEBHOOK_URL) return;
  const file = payload.file_name || payload.file_key || "a Figma file";
  const event = payload.event_type || "change";
  const text = `Figma tokens changed: ${file} (${event}) — run the elf drift check.`;
  try {
    const response = await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      console.error(`slack notify failed: ${response.status}`);
    }
  } catch (error) {
    console.error(`slack notify failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function fetchDriftData(env) {
  const repo = env.GITHUB_REPO;
  if (!repo) {
    return { ok: false, error: "worker not configured: set GITHUB_REPO" };
  }
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "elf-tokens-bridge/1.0",
    ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
  };

  const fetchFile = async (name) => {
    const response = await fetch(`https://api.github.com/repos/${repo}/contents/${name}?ref=drift-data`, { headers });
    if (!response.ok) return null;
    const data = await response.json();
    return Buffer.from(data.content, "base64").toString("utf8");
  };

  const [statusRaw, report] = await Promise.all([fetchFile("drift-status.json"), fetchFile("drift-report.md")]);
  if (!statusRaw) {
    return { ok: false, error: "no drift data yet: run the 'Publish Drift Data' workflow, then re-check" };
  }
  const status = JSON.parse(statusRaw);
  return {
    ok: true,
    repo,
    checkedAt: status.checkedAt ?? null,
    driftFound: status.driftFound,
    counts: {
      valueMismatches: status.valueMismatches,
      missingInCode: status.missingInCode,
      missingInFigma: status.missingInFigma,
    },
    report: report ?? null,
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method === "GET") {
      const url = new URL(request.url);
      const fileKey = url.searchParams.get("fileKey");
      const passcode = url.searchParams.get("passcode");

      if (passcode !== env.FIGMA_PASSCODE) {
        return json({ ok: false, error: "bad passcode" }, 403);
      }
      if (!fileKey) {
        return json({ ok: false, error: "missing fileKey" }, 400);
      }

      const data = await fetchDriftData(env);
      return json({ ...data, fileKey });
    }

    if (request.method !== "POST") {
      return json({ ok: false, error: "method not allowed" }, 405);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ ok: false, error: "invalid json" }, 400);
    }

    if (payload.passcode !== env.FIGMA_PASSCODE) {
      return json({ ok: false, error: "bad passcode" }, 403);
    }

    if (payload.event_type === "PING") {
      return json({ ok: true, pong: true });
    }

    const repo = env.GITHUB_REPO;
    const token = env.GITHUB_TOKEN;
    let forwarded = false;

    if (repo && token) {
      const response = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "elf-tokens-bridge/1.0",
        },
        body: JSON.stringify({
          event_type: "figma-tokens-updated",
          client_payload: {
            fileKey: payload.file_key ?? "",
            fileName: payload.file_name ?? "",
            eventType: payload.event_type ?? "",
            passcode: payload.passcode ?? "",
          },
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return json({ ok: false, error: `github: ${response.status} ${body.slice(0, 500)}` }, 502);
      }
      forwarded = true;
    }

    await notifySlack(env, payload);

    return json({ ok: true, forwarded });
  },
};
