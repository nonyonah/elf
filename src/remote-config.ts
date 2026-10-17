/**
 * Remote config: the elf console can own deprecations, nameMapping,
 * modeStrategy and modeName — team-level decisions that shouldn't live only
 * in a committed file. Resolution order per CONTRACT.md:
 *
 *   remote (ETag-revalidated) → cached copy (.elf/config.remote.json) → local
 *
 * Never fails a run: an unreachable dashboard degrades to the last cache,
 * then to the local file. One line on stderr says which was used.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Deprecation, DriftConfig, ModeName, ModeStrategy } from "./core/types.js";

export interface RemoteConfig {
  deprecations?: Deprecation[];
  nameMapping?: Record<string, string>;
  modeStrategy?: ModeStrategy;
  modeName?: ModeName;
}

export interface RemoteConfigResult {
  config: RemoteConfig | null;
  source: "remote" | "cache" | "none";
}

export interface RemoteConfigCache {
  etag?: string;
  fetchedAt: string;
  config: RemoteConfig;
}

const TIMEOUT_MS = 5000;

export function isRemoteConfig(value: unknown): value is RemoteConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.deprecations !== undefined && !Array.isArray(record.deprecations)) return false;
  if (record.nameMapping !== undefined) {
    const mapping = record.nameMapping;
    if (mapping === null || typeof mapping !== "object" || Array.isArray(mapping)) return false;
    for (const target of Object.values(mapping as Record<string, unknown>)) {
      if (typeof target !== "string") return false;
    }
  }
  if (record.modeStrategy !== undefined && record.modeStrategy !== "modes" && record.modeStrategy !== "collections") {
    return false;
  }
  if (record.modeName !== undefined && record.modeName !== null) {
    const mode = record.modeName;
    if (typeof mode === "string") {
      // fine
    } else if (Array.isArray(mode) && mode.every((name) => typeof name === "string")) {
      // fine
    } else {
      return false;
    }
  }
  return true;
}

/**
 * The endpoint's response is the CONTRACT.md envelope:
 * `{ "schema": 1, "config": { … }, "updatedAt": "…", "etag": "\"cfg-7\"" }`.
 * The `etag` also rides the standard `ETag` header (preferred).
 */
export function unwrapRemoteConfigEnvelope(value: unknown): { config: RemoteConfig; etag?: string } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isRemoteConfig(record.config)) return null;
  return {
    config: record.config,
    ...(typeof record.etag === "string" ? { etag: record.etag } : {}),
  };
}

function isRemoteConfigCache(value: unknown): value is RemoteConfigCache {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.etag !== undefined && typeof record.etag !== "string") return false;
  return isRemoteConfig(record.config);
}

/** The dashboard wins over the local file — but only for the fields it provides. */
export function applyRemoteConfig(config: DriftConfig, remote: RemoteConfig | null): DriftConfig {
  if (!remote) return config;
  return {
    ...config,
    ...(remote.deprecations === undefined ? {} : { deprecations: remote.deprecations }),
    ...(remote.nameMapping === undefined ? {} : { nameMapping: remote.nameMapping }),
    ...(remote.modeStrategy === undefined ? {} : { modeStrategy: remote.modeStrategy }),
    ...(remote.modeName === undefined ? {} : { modeName: remote.modeName }),
  };
}

export function readRemoteCache(file: string): RemoteConfigCache | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isRemoteConfigCache(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeRemoteCache(file: string, entry: RemoteConfigCache): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`);
}

/**
 * One attempt, 5 s timeout, no retries — this rides on every check, so the
 * fallback (cache, then local) stays fast and the dashboard being down is
 * never mistaken for the check being down.
 */
export async function fetchRemoteConfig(options: {
  url: string;
  token: string;
  cacheFile: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<RemoteConfigResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const cache = readRemoteCache(options.cacheFile);
  const endpoint = `${options.url.replace(/\/+$/, "")}/api/v1/projects/me/config`;

  let response: Response;
  try {
    response = await doFetch(endpoint, {
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: "application/json",
        ...(cache?.etag ? { "If-None-Match": cache.etag } : {}),
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
    });
  } catch {
    return cache ? { config: cache.config, source: "cache" } : { config: null, source: "none" };
  }

  if (response.status === 304) {
    return cache ? { config: cache.config, source: "remote" } : { config: null, source: "none" };
  }
  if (!response.ok) {
    return cache ? { config: cache.config, source: "cache" } : { config: null, source: "none" };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const envelope = unwrapRemoteConfigEnvelope(body);
  if (!envelope) {
    return cache ? { config: cache.config, source: "cache" } : { config: null, source: "none" };
  }

  const etag = response.headers.get("etag") ?? envelope.etag;
  writeRemoteCache(options.cacheFile, {
    ...(etag ? { etag } : {}),
    fetchedAt: new Date().toISOString(),
    config: envelope.config,
  });
  return { config: envelope.config, source: "remote" };
}
