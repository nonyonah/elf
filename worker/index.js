export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response("invalid json", { status: 400 });
    }

    if (payload.passcode !== env.FIGMA_PASSCODE) {
      return new Response("bad passcode", { status: 403 });
    }

    if (payload.event_type === "PING") {
      return new Response("pong");
    }

    const repo = env.GITHUB_REPO;
    const token = env.GITHUB_TOKEN;
    if (!repo || !token) {
      return new Response("worker not configured: set GITHUB_REPO and GITHUB_TOKEN", { status: 500 });
    }

    const response = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
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
      return new Response(`github: ${response.status} ${body.slice(0, 200)}`, { status: 502 });
    }

    return new Response("ok");
  },
};
