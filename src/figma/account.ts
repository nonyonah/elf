import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { readConnectionJson } from "../connection-service.js";

export interface FigmaAccount { accessToken: string; refreshToken: string; expiresAt: number; origin: string; }
export function accountPath(): string {return process.env.ELF_FIGMA_ACCOUNT_PATH ?? join(homedir(), ".elf", "figma-account.json");}
function directory(): void {
  mkdirSync(dirname(accountPath()), {recursive: true, mode: 0o700});
  const stat = lstatSync(dirname(accountPath()));
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && ((stat.mode & 0o022) || stat.uid !== process.getuid?.()))) throw new Error("Figma credentials require a directory owned by you that other users cannot modify.");
}
export function validateAccount(data: unknown, origin: string): FigmaAccount {
  const value = data as Partial<FigmaAccount> | null;
  if (!value || typeof value.accessToken !== "string" || !value.accessToken || typeof value.refreshToken !== "string" || !value.refreshToken || typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) throw new Error("Figma connection returned invalid credentials.");
  return {accessToken: value.accessToken, refreshToken: value.refreshToken, expiresAt: value.expiresAt, origin};
}
export function readFigmaAccount(): FigmaAccount | null {
  let fd: number;
  try {fd = openSync(accountPath(), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);} catch (error) {if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error;}
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16_384 || (process.platform !== "win32" && ((stat.mode & 0o077) || stat.uid !== process.getuid?.()))) throw new Error("Figma credentials must be a private regular file.");
    const value = JSON.parse(readFileSync(fd, "utf8")) as FigmaAccount;
    const url = new URL(value.origin);
    if (url.protocol !== "https:" || url.origin !== value.origin || typeof value.accessToken !== "string" || typeof value.refreshToken !== "string" || !Number.isFinite(value.expiresAt)) throw new Error("Invalid saved Figma account. Reconnect from Settings.");
    return value;
  } finally {closeSync(fd);}
}
export function writeFigmaAccount(value: FigmaAccount): void {
  directory(); const path = accountPath(); const target = lstatSync(path, {throwIfNoEntry: false});
  if (target && (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1)) throw new Error("Figma credentials must not be a link.");
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  try {writeFileSync(temporary, JSON.stringify(value), {flag: "wx", mode: 0o600}); renameSync(temporary, path);} finally {rmSync(temporary, {force: true});}
}
export function removeFigmaAccount(): void {directory(); rmSync(accountPath(), {force: true});}

let refreshing: Promise<string> | null = null;
export async function figmaAccessToken(forceRefresh = false): Promise<string> {
  const account = readFigmaAccount();
  if (!account) throw new Error("Connect your Figma account in Elf Settings to verify this file.");
  if (!forceRefresh && account.expiresAt > Date.now() + 60_000) return account.accessToken;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    // The origin is pinned when the account is connected; no caller supplies a URL.
    const response = await fetch(new URL("/api/local-connect/figma/refresh", account.origin), {method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000), headers: {"Content-Type": "application/json"}, body: JSON.stringify({refreshToken: account.refreshToken})});
    if (!response.ok || Number(response.headers.get("Content-Length")) > 16_384) throw new Error("Reconnect your Figma account in Elf Settings.");
    const refreshed = await readConnectionJson(response) as Partial<FigmaAccount>;
    const value = validateAccount({...account, ...refreshed}, account.origin);
    // Disconnecting or replacing an account during refresh must win.
    if (readFigmaAccount()?.refreshToken !== account.refreshToken) throw new Error("Figma connection changed during refresh.");
    writeFigmaAccount(value); return value.accessToken;
  })().finally(() => {refreshing = null;});
  return refreshing;
}
