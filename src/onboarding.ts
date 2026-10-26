import { constants, existsSync, lstatSync, openSync, closeSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { detectCodebaseSource } from "./codebase/index.js";
import { loadConfig } from "./config.js";
import type { BridgeStatus } from "../mcp/src/bridge.js";

export interface SetupInput {
  tokenPath: string;
  source: "auto" | "css" | "tailwind" | "tokens-json";
  componentsPath?: string;
  autoSync: boolean;
}
export interface OnboardingController {
  status(): Record<string, unknown>;
  save(input: unknown): void;
  validate?(input: unknown): void;
  start(): Promise<void>;
  requestPairingCode?(): Promise<void>;
  projectAction?(action: string, input: unknown): Promise<unknown>;
}

/** Resolve only existing project resources, including their symlink targets. */
export function projectResource(root: string, input: unknown, directory = false): string {
  if (typeof input !== "string" || !input.trim() || input.includes("\0") || isAbsolute(input)) {
    throw new Error("Choose a path relative to this project.");
  }
  const canonicalRoot = realpathSync(root);
  const requested = resolve(root, input);
  const requestedRelative = relative(resolve(root), requested);
  if (requestedRelative === ".." || requestedRelative.startsWith(`..${sep}`) || isAbsolute(requestedRelative)) throw new Error("The selected path must stay inside this project.");
  let path: string;
  try { path = realpathSync(requested); }
  catch { throw new Error("That path could not be found in this project. Check the spelling and try again."); }
  const rel = relative(canonicalRoot, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("The selected path must stay inside this project.");
  const stat = lstatSync(path);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(directory ? "Choose a component folder." : "Choose a token source file.");
  return path;
}

export function detectProjectSources(root: string): string[] {
  return ["tokens.json", "src/tokens.json", "src/app/globals.css", "app/globals.css", "src/index.css", "src/styles/globals.css", "styles/globals.css", "tailwind.config.ts", "tailwind.config.js"].filter(path => {
    try { projectResource(root, path); return true; } catch { return false; }
  });
}

export function validateProjectSources(configPath: string, input: unknown): SetupInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Invalid project setup.");
  const data = input as SetupInput;
  if (!["auto", "css", "tailwind", "tokens-json"].includes(data.source) || typeof data.autoSync !== "boolean") throw new Error("Choose a token format and watching preference.");
  const root = dirname(resolve(configPath));
  projectResource(root, data.tokenPath);
  if (data.source === "auto") detectCodebaseSource(data.tokenPath);
  if (data.componentsPath) projectResource(root, data.componentsPath, true);
  return data;
}

/** Update only setup-owned fields; refuse links and preserve unrelated config. */
export function saveProjectSetup(configPath: string, input: unknown, status: BridgeStatus): void {
  const data = validateProjectSources(configPath, input);
  if (!status.connected || !status.file?.key) throw new Error("Connect the Figma file before saving setup.");
  if (status.file.key === "draft" || !status.file.key.trim()) throw new Error("Figma did not expose a real file identity. Reload the updated Elf Bridge plugin and pair this file again.");
  // Automatic writes need an existing, reviewed batch description, not guessed output.
  if (data.autoSync) throw new Error("Start with monitoring. Automatic sync will be enabled after reviewing a sync plan.");
  let existing: Record<string, any> = {};
  if (existsSync(configPath)) {
    const stat = lstatSync(configPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Project config must be a regular file, not a link.");
    existing = JSON.parse(readFileSync(configPath, "utf8"));
  }
  if (existing.figma?.fileKey && existing.figma.fileKey !== status.file.key) throw new Error(`The connected Figma file (${status.file.key}) does not match this project's configured file (${existing.figma.fileKey}). Open the configured file before continuing.`);
  const next = {
    ...existing,
    figma: { ...existing.figma, fileKey: status.file.key, source: "bridge" },
    codebase: { source: data.source, path: data.tokenPath },
    components: data.componentsPath ? { path: data.componentsPath, manifest: existing.components?.manifest ?? "elf.manifest.json" } : undefined,
    runtime: { ...existing.runtime, autoSync: false, projectConfigured: true, setupComplete: false },
  };
  writeProjectConfig(configPath, next);
}

export function completeProjectSetup(configPath: string): void {
  const stat = lstatSync(configPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Project config must be a regular file, not a link.");
  const next = JSON.parse(readFileSync(configPath, "utf8"));
  if (!next.runtime?.projectConfigured && !next.runtime?.setupComplete) throw new Error("Finish project setup first.");
  next.runtime = { ...next.runtime, setupComplete: true };
  writeProjectConfig(configPath, next);
}

export function writeProjectConfig(configPath: string, next: unknown): void {
  const target = lstatSync(configPath, { throwIfNoEntry: false });
  if (target && (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1)) throw new Error("Project config must be a regular file, not a link.");
  const root = dirname(resolve(configPath));
  const temporary = join(root, `.elf-setup-${randomBytes(12).toString("hex")}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`); } finally { closeSync(fd); }
  try { loadConfig(temporary); renameSync(temporary, configPath); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
