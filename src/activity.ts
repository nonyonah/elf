import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
export interface SyncedChange { kind: string; key: string; name: string; action: string; before: string | null; after: string; }
export interface Activity { id: string; at: string; type: "sync" | "conflict" | "error" | "check" | "description"; message: string; changes?: SyncedChange[]; }

function pathFor(configPath: string): string { return join(dirname(configPath), ".elf", "activity.jsonl"); }
function validate(fd: number): void {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("Project activity storage must be a private regular file owned by you.");
}
export function readActivity(configPath: string): Activity[] {
  let fd: number;
  try { fd = openSync(pathFor(configPath), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  try {
    validate(fd);
    const size = fstatSync(fd).size; const length = Math.min(size, 1024 * 1024); const bytes = Buffer.alloc(length);
    readSync(fd, bytes, 0, length, size - length);
    return bytes.toString("utf8").split("\n").flatMap(line => { try { return [JSON.parse(line) as Activity]; } catch { return []; } }).slice(-50).reverse();
  } finally { closeSync(fd); }
}
export function recordActivity(configPath: string, type: Activity["type"], message: string, changes?: SyncedChange[]): void {
  const detail = changes ? { changes: changes.slice(0, 200).map(change => ({ kind: change.kind.slice(0, 30), key: change.key.slice(0, 200), name: change.name.slice(0, 200), action: change.action.slice(0, 30), before: change.before?.slice(0, 1000) ?? null, after: change.after.slice(0, 1000) })) } : {};
  const path = pathFor(configPath); const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const directory = lstatSync(dir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (process.platform !== "win32" && ((directory.mode & 0o022) !== 0 || directory.uid !== process.getuid?.()))) throw new Error("Project activity needs a directory owned by you that others cannot modify.");
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    validate(fd);
    if (fstatSync(fd).size > 1024 * 1024) {
      // Keep one bounded previous log. Renaming never follows a destination symlink.
      renameSync(path, `${path}.previous`);
      const next = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try { validate(next); writeSync(next, JSON.stringify({ id: randomUUID(), at: new Date().toISOString(), type, message: message.slice(0, 800), ...detail }) + "\n"); }
      finally { closeSync(next); }
    } else writeSync(fd, JSON.stringify({ id: randomUUID(), at: new Date().toISOString(), type, message: message.slice(0, 800), ...detail }) + "\n");
  } finally { closeSync(fd); }
}
