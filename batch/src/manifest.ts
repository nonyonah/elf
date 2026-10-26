import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { Manifest, ManifestComponent } from "./types.js";

export function emptyManifest(): Manifest {
  return { version: 1, components: {}, tokens: {} };
}

/** Missing file → an empty manifest; a broken one is an error, never ignored. */
export function loadManifest(path: string): Manifest {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return emptyManifest();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}. Fix or delete it to start fresh.`);
  }

  const manifest = parsed as Partial<Manifest>;
  if (manifest.version !== 1) {
    throw new Error(`${path} has version ${String(manifest.version)} — this batch understands version 1 only.`);
  }

  return {
    version: 1,
    components: manifest.components ?? {},
    tokens: manifest.tokens ?? {},
    ...(manifest.styles ? { styles: manifest.styles } : {}),
  };
}

/**
 * Writes the manifest atomically (tmp + rename) with sorted keys and a fixed
 * field order, so a diff between two runs only shows real changes.
 */
export function saveManifest(path: string, manifest: Manifest): void {
  const ordered = {
    version: 1 as const,
    components: sortByKey(manifest.components, canonicalComponent),
    tokens: sortByKey(manifest.tokens, (entry) => ({
      figmaVariableId: entry.figmaVariableId,
      valueHash: entry.valueHash,
      ...(entry.remoteHash ? { remoteHash: entry.remoteHash } : {}),
    })),
    ...(manifest.styles ? { styles: sortByKey(manifest.styles, entry => entry) } : {}),
  };

  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) throw new Error("Manifest must be a regular file, not a link.");
  const tmp = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(ordered, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
}

/** 16 hex chars of sha256 over a canonical JSON — enough to spot a change. */
export function hashSpec(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sortByKey<T, R>(record: Record<string, T>, shape: (entry: T) => R): Record<string, R> {
  const out: Record<string, R> = {};
  for (const key of Object.keys(record).sort()) out[key] = shape(record[key]);
  return out;
}

function canonicalComponent(entry: ManifestComponent): ManifestComponent {
  return {
    figmaNodeId: entry.figmaNodeId,
    specHash: entry.specHash,
    ...(entry.sourceHash ? { sourceHash: entry.sourceHash } : {}),
    ...(entry.nodeHash === undefined ? {} : { nodeHash: entry.nodeHash }),
    status: entry.status,
    updatedAt: entry.updatedAt,
    ...(entry.error === undefined ? {} : { error: entry.error }),
  };
}
