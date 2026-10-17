import type { DriftCounts } from "./types";

const DRIFT_KEYS: (keyof DriftCounts)[] = [
  "valueMismatches",
  "missingInCode",
  "missingInFigma",
  "componentsOutOfDate",
  "componentsChangedInFigma",
  "componentsInCodeNotInFigma",
  "componentsInFigmaNotInCode",
  "deprecationOverdue",
];

export function totalDriftCounts(
  counts: Partial<DriftCounts> | null | undefined,
): number {
  if (!counts) return 0;
  let total = 0;
  for (const key of DRIFT_KEYS) total += counts[key] ?? 0;
  return total;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "never";
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 min ago" : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 22) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return days === 1 ? "yesterday" : `${days} days ago`;
  return formatDate(iso);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(date);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/** Parses a `YYYY-MM-DD` string as a local date so it never shifts a day. */
export function formatIsoDate(value: string | null | undefined): string {
  if (!value) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  return formatDate(date.toISOString());
}

export function shortCommit(commit: string | null | undefined): string | null {
  if (!commit) return null;
  return commit.slice(0, 7);
}

export function formatDayLabel(date: string): string {
  const parsed = new Date(`${date}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(parsed);
}

const HEX_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function isColorValue(value: string): boolean {
  return HEX_PATTERN.test(value.trim());
}

export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
