#!/usr/bin/env node
// Thin shim: registers tsx's ESM loader so the bridge host can stay TypeScript.
import { register } from "tsx/esm/api";

register();
const { main } = await import("../src/bridge-host.ts");
process.exitCode = await main(process.argv.slice(2));
