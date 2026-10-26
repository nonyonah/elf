import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
const files = ["src/core/hash.ts", "src/core/pairing-auth.ts"];
const source = files.map(file => readFileSync(file, "utf8").replace(/^import .*;\n/gm, "").replace(/export /g, "")).join("\n");
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const path = "bridge-plugin/ui.html";
const html = readFileSync(path, "utf8");
const block = `<!-- BEGIN PAIRING AUTH -->\n<script>\n${js}</script>\n<!-- END PAIRING AUTH -->`;
writeFileSync(path, html.includes("<!-- BEGIN PAIRING AUTH -->") ? html.replace(/<!-- BEGIN PAIRING AUTH -->[\s\S]*?<!-- END PAIRING AUTH -->/, block) : html.replace("  <script>", block + "\n  <script>"));
