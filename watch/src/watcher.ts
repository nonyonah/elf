import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { watch } from "chokidar";
import { connectWatchBridge, isBridgeUnavailable } from "./bridge.js";
import { runElfCheck } from "./check.js";
import { syncChanges } from "./sync.js";
import type {
  CheckResult,
  SyncSummary,
  WatchBridge,
  WatchController,
  WatchOptions,
} from "./types.js";

type CloseableBridge = WatchBridge & { close?: () => void };

const IGNORED_DIR = /(^|[/\\])(node_modules|dist|build|out|coverage|\.git|\.next|\.turbo)([/\\]|$)/;
const IGNORED_FILE = /(^|[/\\])(elf\.manifest\.json|drift-report\.md|drift-status\.json)$/;

/**
 * Watches tokens and components, debounces editor saves, and pushes one
 * incremental batch per burst. A failed bridge connection keeps the dirty
 * flags set and retries on a timer; it never exits the process.
 */
export function startWatch(options: WatchOptions): WatchController {
  const log = options.log ?? ((line: string) => console.log(line));
  const errorLog = options.error ?? ((line: string) => console.error(line));
  const debounceMs = options.debounceMs ?? 1_500;
  const retryMs = options.retryMs ?? 10_000;
  const force = new Set(options.forceComponents ?? []);
  const bridgeFactory = options.bridgeFactory ?? (() => connectWatchBridge(options.config.batch.root));
  const runCheck = options.runCheck ?? runElfCheck;

  if (!existsSync(options.config.batch.tokensFile)) {
    throw new Error(`Tokens file not found: ${options.config.batch.tokensFile}.`);
  }
  if (!existsSync(options.config.batch.componentsDir)) {
    throw new Error(`Components folder not found: ${options.config.batch.componentsDir}.`);
  }

  let bridge: CloseableBridge | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let dirtyTokens = false;
  let dirtyComponents = false;
  let flushing: Promise<void> | null = null;
  let rerun = false;
  let offline = false;
  let offlineLogged = false;
  let stopping = false;
  let resolveReady: () => void = () => {};
  let resolveDone: () => void = () => {};
  let readySettled = false;
  const settleReady = (): void => {
    if (readySettled) return;
    readySettled = true;
    resolveReady();
  };
  const ready = new Promise<void>((resolvePromise) => {
    resolveReady = resolvePromise;
  });
  const done = new Promise<void>((resolvePromise) => {
    resolveDone = resolvePromise;
  });

  const watcher = watch([options.config.batch.tokensFile, options.config.batch.componentsDir], {
    ignoreInitial: true,
    ignored: (path: string) => IGNORED_DIR.test(path) || IGNORED_FILE.test(path),
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
  });

  watcher.on("add", (path) => mark(path));
  watcher.on("change", (path) => mark(path));
  watcher.on("unlink", (path) => mark(path));
  watcher.on("error", (error) => {
    errorLog(`elf-watch: watcher error: ${(error as Error).message}`);
    settleReady();
  });
  watcher.on("ready", () => {
    const alerts = options.notify ? " (Slack alerts on)" : "";
    log(
      `watching ${displayPath(options.config.batch.componentsDir)} and ` +
        `${displayPath(options.config.batch.tokensFile)}${alerts}`,
    );
    settleReady();
  });

  function mark(path: string): void {
    if (stopping) return;
    if (resolve(path) === options.config.batch.tokensFile) dirtyTokens = true;
    else dirtyComponents = true;
    schedule(debounceMs);
  }

  function schedule(delay: number): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void requestFlush();
    }, delay);
  }

  function scheduleRetry(): void {
    if (retryTimer || stopping) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void requestFlush();
    }, retryMs);
  }

  function requestFlush(): Promise<void> {
    if (flushing) {
      rerun = true;
      return flushing;
    }
    flushing = flush().finally(() => {
      flushing = null;
      if ((dirtyTokens || dirtyComponents) && !offline && !stopping) schedule(0);
    });
    return flushing;
  }

  async function flush(): Promise<void> {
    do {
      rerun = false;
      if (stopping) return;
      const tokens = dirtyTokens;
      const components = dirtyComponents;
      dirtyTokens = false;
      dirtyComponents = false;
      if (!tokens && !components) return;
      await syncOnce(tokens);
    } while (rerun && !stopping);
  }

  async function syncOnce(tokensChanged: boolean): Promise<void> {
    try {
      if (!bridge) bridge = (await bridgeFactory()) as CloseableBridge;
      const summary = await syncChanges({
        config: options.config.batch,
        bridge,
        tokensChanged,
        forceComponents: force,
        log,
        stopping: () => stopping,
      });
      const bridgeFailure = summary.failures.find((failure) =>
        isBridgeUnavailable(new Error(failure.error)),
      );
      if (bridgeFailure) throw new Error(bridgeFailure.error);
      offline = false;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      offlineLogged = false;
      if (summary.aborted) return;

      const check = await runCheck(
        options.config.checkConfigPath ?? "",
        options.config.reportDir,
        options.notify ?? false,
      );
      log(formatSummary(summary, check, options.notify ?? false));
      if (summary.conflicts.length > 0) {
        log(
          `! skipped ${summary.conflicts.length} Figma-changed component(s): ${summary.conflicts.join(", ")} ` +
            "(use --force-component <name> once to overwrite).",
        );
      }
    } catch (error) {
      bridge = null;
      if (isBridgeUnavailable(error)) {
        offline = true;
        dirtyTokens ||= tokensChanged;
        dirtyComponents = true;
        if (!offlineLogged) {
          log("Figma isn't connected — changes are queued; retrying every 10s.");
          offlineLogged = true;
        }
        scheduleRetry();
        return;
      }
      errorLog(`elf-watch: ${(error as Error).message}`);
    }
  }

  async function close(): Promise<void> {
    if (stopping) return done;
    stopping = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (retryTimer) clearTimeout(retryTimer);
    debounceTimer = null;
    retryTimer = null;
    settleReady();
    await watcher.close();
    if (flushing) await flushing;
    bridge?.close?.();
    bridge = null;
    resolveDone();
    return done;
  }

  return { ready, done, close };
}

export function formatSummary(summary: SyncSummary, check: CheckResult, notify = false): string {
  const parts: string[] = [];
  if (summary.components > 0) {
    parts.push(`${summary.components} component${summary.components === 1 ? "" : "s"}`);
  }
  if (summary.tokens > 0) {
    parts.push(`${summary.tokens} token${summary.tokens === 1 ? "" : "s"}`);
  }
  if (summary.styles > 0) {
    parts.push(`${summary.styles} style${summary.styles === 1 ? "" : "s"}`);
  }
  const synced = parts.length > 0 ? `synced ${parts.join(", ")}` : "no changes";
  const failed =
    summary.failed.length > 0
      ? `; ${summary.failed.length} failed`
      : "";
  const drift =
    check.status === "clean"
      ? "none"
      : check.status === "drift"
        ? `${check.total ?? "?"} item${check.total === 1 ? "" : "s"}`
        : `check failed (${check.message ?? "unknown error"})`;
  const sent =
    check.status === "drift" && notify ? (check.notified ? " (Slack sent)" : " (Slack unchanged)") : "";
  return `${synced}${failed}. drift: ${drift}${sent}.`;
}

function displayPath(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith("..") ? rel : path;
}
