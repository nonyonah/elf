import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface RecordEntry { fileKey: string | null; createdAt: string; }
/** Private, individually revocable pairing keys. Stored digests are authentication secrets. */
export class SessionStore {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const stat = lstatSync(dirname(path));
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("Pairing storage must be a private directory owned by you.");
  }
  private read(): Record<string, RecordEntry> {
    let fd: number;
    try { fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024 || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("Pairing storage is unsafe.");
      const data = JSON.parse(readFileSync(fd, "utf8"));
      if (!data || Array.isArray(data) || typeof data !== "object") throw new Error("Pairing storage is corrupt.");
      return data;
    } finally { closeSync(fd); }
  }
  private save(records: Record<string, RecordEntry>): void {
    const target = lstatSync(this.path, { throwIfNoEntry: false });
    if (target && (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1)) throw new Error("Pairing storage must not be a link.");
    const temp = `${this.path}.${randomBytes(12).toString("hex")}.tmp`;
    try { writeFileSync(temp, JSON.stringify(records), { flag: "wx", mode: 0o600 }); renameSync(temp, this.path); }
    finally { rmSync(temp, { force: true }); }
  }
  private key(session: string): string { return createHash("sha256").update(session).digest("hex"); }
  issue(): string {
    const records = this.read();
    if (Object.keys(records).length >= 1000) throw new Error("Revoke unused Figma pairings before adding more.");
    const session = `elfp_${randomBytes(32).toString("base64url")}`;
    records[this.key(session)] = { fileKey: null, createdAt: new Date().toISOString() };
    this.save(records); return session;
  }
  keyForHint(hint: string): string | null {
    if (!/^[a-f0-9]{64}$/.test(hint)) return null;
    return Object.keys(this.read()).find(key => createHash("sha256").update(key).digest("hex") === hint) ?? null;
  }
  valid(session: string): boolean { return /^elfp_[A-Za-z0-9_-]{43}$/.test(session) && Object.hasOwn(this.read(), this.key(session)); }
  bind(session: string, fileKey: string): boolean {
    return this.bindKey(this.key(session), fileKey);
  }
  bindKey(key: string, fileKey: string): boolean {
    if (!fileKey.trim() || fileKey === "draft") return false;
    const records = this.read(); const entry = records[key];
    if (!entry || (entry.fileKey && entry.fileKey !== fileKey)) return false;
    if (!entry.fileKey) { entry.fileKey = fileKey; this.save(records); }
    return true;
  }
  revoke(fileKey: string): void {
    const records = this.read();
    for (const [key, entry] of Object.entries(records)) if (entry.fileKey === fileKey || entry.fileKey === null) delete records[key];
    this.save(records);
  }
}
