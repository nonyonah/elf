import { Bridge } from "./bridge.js";
import { loadRuntimeBridgeConfig } from "./config.js";
import { SessionStore } from "./sessions.js";

const config = loadRuntimeBridgeConfig();
const bridge = new Bridge({ ...config,
  sessionStore: new SessionStore(process.env.ELF_BRIDGE_SESSION_PATH ?? config.sessionStorePath!),
  shutdown: () => { void bridge.stop().finally(() => process.exit(0)); },
});
try {
  const port = await bridge.start();
  process.send?.({ port });
  process.disconnect?.();
  const stop = () => { void bridge.stop().finally(() => process.exit(0)); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
} catch { process.send?.({ error: "Could not start the shared Elf bridge." }); process.exit(1); }
