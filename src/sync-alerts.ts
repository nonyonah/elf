import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

/** Persist only a dedupe key, never webhook credentials or message contents. */
export class SyncAlerts {
  private readonly path: string;
  constructor(configPath: string) { this.path = join(dirname(configPath), ".elf", "sync-alert.json"); }
  private directory(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const stat = lstatSync(dirname(this.path));
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && ((stat.mode & 0o022) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("Sync alert storage must be owned by you and protected from other users' writes.");
  }
  private read(): string | null {
    let fd: number;
    try { fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096 || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("Sync alert state must be a private regular file.");
      const data = JSON.parse(readFileSync(fd, "utf8"));
      if (data.key !== null && typeof data.key !== "string") throw new Error("Sync alert state is corrupt.");
      return data.key;
    } finally { closeSync(fd); }
  }
  async update(key: string | null, send?: () => Promise<void>): Promise<void> {
    this.directory();
    if (this.read() === key) return;
    if (key !== null) { if (!send) throw new Error("A notification sender is required."); await send(); }
    const target = lstatSync(this.path, { throwIfNoEntry: false });
    if (target && (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1)) throw new Error("Sync alert state must not be a link.");
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, JSON.stringify({ key }), { flag: "wx", mode: 0o600 }); renameSync(temp, this.path); }
    finally { rmSync(temp, { force: true }); }
  }
}
