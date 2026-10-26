let session: string | null = null;
let opening: Promise<void> | null = null;
const STORAGE_KEY = "elf.settings.session";

async function openSession(): Promise<void> {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const bootstrap = fragment.get("elf");
  if (bootstrap) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    const response = await globalThis.fetch("/api/session", { method: "POST", headers: { "X-Elf-Request": "1", "X-Elf-Bootstrap": bootstrap } });
    if (!response.ok) throw new Error("This settings link expired. Run elf settings to open a new one.");
    session = (await response.json()).session;
    try { sessionStorage.setItem(STORAGE_KEY, session!); } catch {}
  } else {
    try { session = sessionStorage.getItem(STORAGE_KEY); } catch {}
  }
  if (!session) throw new Error("Open the private Settings link printed in your terminal, or run elf settings.");
}

/** Per-origin session storage avoids sharing credentials with other localhost ports. */
export async function settingsFetch(input: string, init: RequestInit = {}): Promise<Response> {
  if (new URL(input, window.location.origin).origin !== window.location.origin) throw new Error("Settings API requests must stay on this page’s origin.");
  if (!opening) opening = openSession();
  await opening;
  const headers = new Headers(init.headers); headers.set("X-Elf-Session", session!);
  const response = await globalThis.fetch(input, { ...init, headers });
  if (response.status === 401) {
    session = null;
    try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
    throw new Error("Your Settings session expired. Run elf settings to open a new one.");
  }
  if (new URL(input, window.location.origin).pathname.startsWith("/api/") && !response.ok) {
    await settingsJson(response.clone());
  }
  return response;
}


export const RESTART_ELF_MESSAGE = "This page is newer than the running Elf server. Stop Elf with Ctrl+C, run elf start again (or node bin/elf-tokens.js start in this repo), then refresh Settings.";

/** Never show a JSON parser exception for an older or incompatible local server. */
export async function settingsJson(response: Response): Promise<any> {
  if (!response.headers.get("content-type")?.includes("application/json")) throw new Error(RESTART_ELF_MESSAGE);
  let body: any;
  try { body = await response.json(); } catch { throw new Error("Elf returned an unreadable response. Restart Elf and refresh Settings."); }
  if (!response.ok) {
    if (body?.error === "Unknown project action.") throw new Error(RESTART_ELF_MESSAGE);
    throw new Error(typeof body?.error === "string" ? body.error : "The local request could not be completed.");
  }
  return body;
}
