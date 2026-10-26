import { acquireBridge } from "../../mcp/src/runtime.js";
import { BridgeClient } from "../../mcp/src/client.js";
import { loadRuntimeBridgeConfig } from "../../mcp/src/config.js";
import { loadWatchEnv } from "./bridge.js";

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("elf bridge — connect to the shared local Figma bridge\n\nUsage: elf bridge [--stop]\n\nPrints a temporary pairing code. Saved file pairings persist until revoked.\nThe shared host stays available when a terminal or MCP client closes.\n--stop stops an unused host; active clients must close first."); return 0;
  }
  if (argv.some(arg => arg !== "--stop")) throw new Error("Unknown bridge option.");
  loadWatchEnv(process.cwd());
  const config = loadRuntimeBridgeConfig();
  if (argv.includes("--stop")) {
    const client = await BridgeClient.connect(config);
    try { await client.call("__elf_shutdown"); console.log("Shared bridge stopped."); } finally { client.close(); }
    return 0;
  }
  const runtime = await acquireBridge(config, { log: line => console.error(`elf: ${line}`) });
  try {
    const pairing = runtime.pairingCode ?? await runtime.refreshPairingCode();
    console.log(`Pairing code: ${pairing.code}\nPaste this code into the Figma plugin within five minutes.\nSaved pairing survives restarts. Ctrl+C closes this terminal connection.`);
    const off = runtime.connection.onStatus(status => console.log(status.connected ? `Connected: ${status.file?.name ?? "waiting for file details"}` : "Plugin disconnected."));
    await new Promise<void>(resolve => { const stop = () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); resolve(); }; process.once("SIGINT", stop); process.once("SIGTERM", stop); });
    off(); return 0;
  } finally { await runtime.close(); }
}
