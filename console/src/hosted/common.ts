import type { Env } from '../env.js';
import { hashToken } from '../db/tokens.js';

export { hashToken as hash };
export const now = () => Date.now();
export function secret(bytes = 32) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
export function origin(env: Env) {
  const url = new URL(env.CONSOLE_ORIGIN ?? 'https://elf-console.nonyonah.workers.dev');
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('Invalid service origin');
  return url.origin;
}
export async function jsonBody(request: Request, limit = 262144): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('Expected JSON');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing body');
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('Request too large'); }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data);
  return JSON.parse(text, (key, value) => {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Reserved property');
    return value;
  });
}
export const noStore = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
