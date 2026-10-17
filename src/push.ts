/**
 * `elf push` — the client half of CONTRACT.md's `POST /api/v1/ingest/code`.
 *
 * Two pure-ish pieces (payload building, retry math) live next to one small
 * network poster so the watcher (P3) can reuse both. Note the retry rules the
 * contract makes normative: 3 attempts total, exponential backoff, honored
 * `Retry-After`, and 400/401 are never retried — a bad token should fail
 * fast and loudly, not hammer the dashboard.
 */
import { execFileSync } from "node:child_process";
import { loadManifest } from "../batch/src/manifest.js";
import { parseComponents } from "../batch/src/parser.js";
import { componentSpecHash } from "../batch/src/sync.js";
import type { DriftResult } from "./core/diff.js";
import { buildStatusPayload, type ReportMeta } from "./core/report.js";
import type { ComponentsConfig, DriftConfig, Token } from "./core/types.js";

export interface GitInfo {
  branch: string;
  commit: string;
}

export interface PushToken {
  name: string;
  category: string;
  value: string;
  mode?: string;
}

export interface PushComponent {
  name: string;
  codeKey: string;
  specHash?: string;
  nodeHash?: string;
  figmaNodeId?: string;
}

export interface CodePushPayload {
  source: "cli" | "watcher";
  checkedAt: string;
  git?: GitInfo;
  config: {
    figmaFileKey: string;
    figmaSource: string;
    codebaseSource: string;
    modeStrategy: string;
    modeName: string | string[] | null;
  };
  figmaTokens: PushToken[];
  codeTokens: PushToken[];
  components?: PushComponent[];
  drift: { found: boolean; counts: Record<string, unknown> };
  report?: string;
}

export interface IngestResponse {
  status: "stored" | "deduped" | string;
  snapshotId?: string;
  receivedAt?: string;
}

export interface PushOutcome {
  ok: boolean;
  status?: number;
  body?: IngestResponse;
  error?: string;
  attempts: number;
}

export interface PostPushOptions {
  url: string;
  token: string;
  payload: CodePushPayload;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

const RETRY_BASE_MS = 1000;

function toPushToken(token: Token): PushToken {
  return {
    name: token.name,
    category: token.category,
    value: token.value,
    ...(token.mode === undefined ? {} : { mode: token.mode }),
  };
}

/**
 * Assemble the exact JSON the dashboard receives. `drift.counts` is the same
 * the status payload carries (minus `driftFound`, which owns the `found`
 * field) so the console and the CLI can never disagree about what counts.
 */
export function buildCodePushPayload(input: {
  source: "cli" | "watcher";
  config: DriftConfig;
  meta: ReportMeta;
  figmaTokens: Token[];
  codeTokens: Token[];
  result: DriftResult;
  report?: string;
  components?: PushComponent[];
  git?: GitInfo;
}): CodePushPayload {
  const counts: Record<string, unknown> = { ...buildStatusPayload(input.result) };
  delete counts.driftFound;
  return {
    source: input.source,
    checkedAt: input.meta.checkedAt,
    ...(input.git === undefined ? {} : { git: input.git }),
    config: {
      figmaFileKey: input.config.figma.fileKey,
      figmaSource: input.meta.figmaSource,
      codebaseSource: input.meta.codebaseSource,
      modeStrategy: input.config.modeStrategy,
      modeName: input.config.modeName,
    },
    figmaTokens: input.figmaTokens.map(toPushToken),
    codeTokens: input.codeTokens.map(toPushToken),
    ...(input.components === undefined ? {} : { components: input.components }),
    drift: { found: input.result.driftFound, counts },
    ...(input.report === undefined ? {} : { report: input.report }),
  };
}

/**
 * The component half of a snapshot: current code specs joined with the
 * last-known Figma linkage from elf.manifest.json. Never calls the bridge —
 * the manifest is the source of truth the drift check already maintains.
 */
export function collectComponentSnapshot(components: ComponentsConfig): PushComponent[] {
  const parsed = parseComponents(components.path);
  const manifest = loadManifest(components.manifest);
  return parsed.map((component) => {
    const entry = manifest.components[component.codeKey];
    return {
      name: component.name,
      codeKey: component.codeKey,
      specHash: componentSpecHash(components.path, component),
      ...(entry?.figmaNodeId ? { figmaNodeId: entry.figmaNodeId } : {}),
      ...(entry?.nodeHash ? { nodeHash: entry.nodeHash } : {}),
    };
  });
}

/** Best effort — snapshots from tarballs and CI images without git are fine. */
export function readGitInfo(cwd: string): GitInfo | undefined {
  const run = (args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
    const commit = run(["rev-parse", "--short", "HEAD"]);
    if (!branch || !commit) return undefined;
    return { branch, commit };
  } catch {
    return undefined;
  }
}

function retryDelayMs(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  const seconds = header === null ? Number.NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return RETRY_BASE_MS * 2 ** (attempt - 1);
}

function describeServerError(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; code?: string } };
    if (parsed.error?.message) return parsed.error.message;
    if (parsed.error?.code) return parsed.error.code;
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return text.slice(0, 200) || "no response body";
}

export async function postCodeSnapshot(options: PostPushOptions): Promise<PushOutcome> {
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = options.maxAttempts ?? 3;
  const endpoint = `${options.url.replace(/\/+$/, "")}/api/v1/ingest/code`;
  let lastError = "the request was never attempted";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.token}`,
        },
        body: JSON.stringify(options.payload),
      });
    } catch (error) {
      lastError = `network error: ${(error as Error).message}`;
      if (attempt < maxAttempts) {
        await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      return { ok: false, error: lastError, attempts: attempt };
    }

    if (response.status === 429 || response.status >= 500) {
      lastError = `the dashboard responded ${response.status}`;
      if (attempt < maxAttempts) {
        await sleep(retryDelayMs(response, attempt));
        continue;
      }
      return { ok: false, status: response.status, error: lastError, attempts: attempt };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        status: response.status,
        error: `${response.status} — ${describeServerError(text)}`,
        attempts: attempt,
      };
    }

    const body = (await response.json().catch(() => ({}))) as IngestResponse;
    return { ok: true, status: response.status, body, attempts: attempt };
  }

  return { ok: false, error: lastError, attempts: maxAttempts };
}
