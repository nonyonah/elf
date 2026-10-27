import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "dist", "bridge-plugin-public");
const manifest = JSON.parse(readFileSync(join(root, "bridge-plugin", "manifest.public.json"), "utf8"));
mkdirSync(output, {recursive: true});
writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
for (const file of ["code.js", "ui.html"]) copyFileSync(join(root, "bridge-plugin", file), join(output, file));
console.log("Public plugin ready: dist/bridge-plugin-public/manifest.json");
