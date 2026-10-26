import { parseTokensJson } from "./codebase/tokens-json.js";
import ignore, { type Ignore } from "ignore";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";

const excluded = /^(node_modules|vendor|dist|build|out|coverage|target|__tests__|__mocks__|__snapshots__|tests?|fixtures?|examples?|storybook-static)$/i;
const componentExtensions = new Set([".tsx", ".jsx", ".js", ".vue", ".svelte", ".astro"]);
const entry = /^(page|layout|loading|error|not-found|route|index|main|app|_app|_document)$/i;
const MAX_FILES = 20_000;
const MAX_BYTES = 2 * 1024 * 1024;
export interface ProjectSources { tokens: string[]; components: string[]; componentRoot?: string; }

/** No imports, package scripts, symlink traversal, or project code execution. */
export function readSource(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error(`Source is not a regular file under 2 MB: ${path}`);
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

export function discoverProject(root: string): ProjectSources {
  const canonical = realpathSync(root);
  const tokens: string[] = []; const components: string[] = [];
  let count = 0;
  const walk = (folder: string, depth: number, inherited: {base: string; matcher: Ignore}[] = []): void => {
    if (depth > 16) throw new Error("Project discovery exceeded 16 directory levels. Exclude generated trees in .gitignore.");
    // Refuse directory symlinks even when they point back inside the project.
    if (realpathSync(folder) !== folder || !lstatSync(folder).isDirectory()) return;
    const rules = [...inherited];
    try { rules.push({base: folder, matcher: ignore().add(readSource(join(folder, ".gitignore")))}); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ELOOP") throw error;
    }
    for (const item of readdirSync(folder, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++count > MAX_FILES) throw new Error("Project discovery exceeded 20,000 entries. Exclude generated trees in .gitignore.");
      if (item.name.startsWith(".") || item.isSymbolicLink()) continue;
      const path = join(folder, item.name); const key = relative(canonical, path).split(sep).join("/");
      let ignored = false;
      for (const rule of rules) {
        const result = rule.matcher.test(relative(rule.base, path).split(sep).join("/") + (item.isDirectory() ? "/" : ""));
        if (result.ignored) ignored = true;
        if (result.unignored) ignored = false;
      }
      if (ignored) continue;
      if (item.isDirectory()) { if (!excluded.test(item.name)) walk(path, depth + 1, rules); continue; }
      if (!item.isFile() || lstatSync(path).size > MAX_BYTES) continue;
      const extension = extname(item.name).toLowerCase();
      if (componentExtensions.has(extension)) {
        const name = basename(item.name, extension);
        if (/\.(test|spec|stories|story|generated)$/i.test(name) || /^(use[A-Z])/.test(name)) continue;
        const inComponents = /(^|\/)(components|ui|widgets)(\/|$)/i.test(key);
        if (entry.test(name) && !inComponents) continue;
        if (!inComponents && extension.match(/^\.(tsx|jsx|js)$/) && !/^[A-Z]/.test(name)) continue;
        const source = readSource(path);
        if (extension === ".tsx" || extension === ".jsx" || extension === ".js") { if (!/<[A-Za-z>]/.test(source)) continue; }
        components.push(path);
      } else if (extension === ".css") {
        const source = readSource(path);
        if (/(?:[:@]root|@theme)\b/.test(source) && /--[\w-]+\s*:/.test(source)) tokens.push(path);
      } else if (/^tailwind\.config\.(?:[cm]?js|ts)$/.test(item.name)) tokens.push(path);
      else if (extension === ".json" && (/(?:tokens?|themes?|design-system)(?:[/.\-_]|$)/i.test(key) || /^(?:colors?|spacing|typography|radii|radius|shadows?|theme|variables)(?:[._-].*)?\.json$/i.test(item.name))) {
        const source = readSource(path);
        // Keep incomplete token JSON discoverable; the check reports its parse
        // error without making Settings or onboarding unavailable.
        try { if (parseTokensJson(path, source).length) tokens.push(path); }
        catch { tokens.push(path); }
      }
    }
  };
  walk(canonical, 0);
  tokens.sort(); components.sort();
  return {tokens, components, ...(components.length ? {componentRoot: canonical} : {})};
}
