import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { accountPath } from './account.js';

export interface VerificationLimit { retryAt: number; planTier?: string; limitType?: string; }
function pathFor(key: string): string {
  return join(dirname(accountPath()), 'verification-limits', `${createHash('sha256').update(key).digest('hex')}.json`);
}
export function readVerificationLimit(key: string): VerificationLimit | null {
  let fd: number | undefined;
  try {
    fd = openSync(pathFor(key), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2048 || (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid?.()))) return null;
    const data = JSON.parse(readFileSync(fd, 'utf8'));
    if (!Number.isFinite(data.retryAt) || data.retryAt <= Date.now() || data.retryAt > 8640000000000000) return null;
    return {retryAt: data.retryAt, ...(typeof data.planTier === 'string' && /^(starter|student|pro|org|enterprise)$/.test(data.planTier) ? {planTier: data.planTier} : {}), ...(data.limitType === 'low' || data.limitType === 'high' ? {limitType: data.limitType} : {})};
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}
export function storeVerificationLimit(key: string, headers: Headers): VerificationLimit {
  const retry = headers.get('Retry-After');
  const milliseconds = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - Date.now() : 60_000;
  // Do not shorten Figma's deadline: low-seat limits can last beyond a day.
  const retryAt = Date.now() + Math.max(60_000, Number.isFinite(milliseconds) ? milliseconds : 60_000);
  const plan = headers.get('X-Figma-Plan-Tier'); const type = headers.get('X-Figma-Rate-Limit-Type');
  const value: VerificationLimit = { retryAt: Math.min(retryAt, 8640000000000000), ...(/^(starter|student|pro|org|enterprise)$/.test(plan || '') ? {planTier: plan!} : {}), ...(type === 'low' || type === 'high' ? {limitType: type} : {}) };
  const path = pathFor(key); const directory = dirname(path);
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && ((stat.mode & 0o022) || stat.uid !== process.getuid?.()))) throw new Error('Verification cooldown storage must be private.');
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  try { writeFileSync(temporary, JSON.stringify(value), {flag: 'wx', mode: 0o600}); renameSync(temporary, path); }
  finally { rmSync(temporary, {force: true}); }
  return value;
}
export function verificationLimitMessage(limit: VerificationLimit): string {
  const date = new Date(limit.retryAt).toISOString().slice(0, 16).replace('T', ' ');
  return `Figma rate-limited verification. Retry after ${date} UTC${limit.limitType ? ` (${limit.limitType} seat limit)` : ''}.`;
}
