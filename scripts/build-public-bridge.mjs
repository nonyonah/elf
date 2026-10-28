import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "dist", "bridge-plugin-public");
const manifest = JSON.parse(readFileSync(join(root, "bridge-plugin", "manifest.public.json"), "utf8"));
mkdirSync(output, {recursive: true});
writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
const source = readFileSync(join(root, "bridge-plugin", "code.js"), "utf8");
const marker = "const PUBLIC_FILE_LINK_REQUIRED = false;";
if (source.split(marker).length !== 2) throw new Error("Public identity build marker missing or duplicated; refusing to create an ambiguous public bundle.");
writeFileSync(join(output, "code.js"), source.replace(marker, "const PUBLIC_FILE_LINK_REQUIRED = true;"));
copyFileSync(join(root, "bridge-plugin", "ui.html"), join(output, "ui.html"));
copyFileSync(join(root, "assets", "brand", "elf-mascot.png"), join(output, "plugin-icon.png"));
console.log("Public plugin ready: dist/bridge-plugin-public/manifest.json");
