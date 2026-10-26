import type { BatchConfig, BridgeCaller } from "../../batch/src/types.js";

export type Log = (line: string) => void;

/** The narrow bridge seam sync uses; tests inject a fake. */
export type WatchBridge = BridgeCaller;

export interface WatchConfig {
  batch: BatchConfig;
  /** Path to elf.config.json, when one exists. */
  checkConfigPath: string | null;
  /** Folder where drift-report.md and drift-status.json are written. */
  reportDir: string;
}

export interface WatchOptions {
  config: WatchConfig;
  bridgeFactory?: () => Promise<WatchBridge>;
  runCheck?: (configPath: string, reportDir: string, notify?: boolean) => Promise<CheckResult>;
  debounceMs?: number;
  retryMs?: number;
  log?: Log;
  error?: Log;
  forceComponents?: string[];
  /** Post the existing Slack/webhook alert after a drift check. */
  notify?: boolean;
}

export interface CheckResult {
  status: "clean" | "drift" | "failed";
  total?: number;
  message?: string;
  /** True when the check posted a Slack/webhook alert. */
  notified?: boolean;
  notificationError?: string;
}

export interface SyncSummary {
  components: number;
  tokens: number;
  styles: number;
  conflicts: string[];
  skipped: string[];
  failed: string[];
  failures: { name: string; error: string }[];
  aborted?: string;
}

export interface WatchController {
  ready: Promise<void>;
  done: Promise<void>;
  close(): Promise<void>;
}
