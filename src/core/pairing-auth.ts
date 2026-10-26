import { sha256Bytes, sha256Hex } from "./hash.js";

export function pairingKey(session: string): string { return sha256Hex(session); }
export function pairingHint(key: string): string { return sha256Hex(key); }
export function pairingProof(key: string, role: "server" | "client", client: string, server: string): string {
  return pairingHmac(key, `${role}\n${client}\n${server}`);
}
export function pairingHmac(key: string, text: string): string {
  const bytes = Uint8Array.from(key.match(/../g)!, part => parseInt(part, 16));
  const inner = new Uint8Array(64 + new TextEncoder().encode(text).length);
  const outer = new Uint8Array(96);
  for (let i = 0; i < 64; i++) { inner[i] = (bytes[i] ?? 0) ^ 0x36; outer[i] = (bytes[i] ?? 0) ^ 0x5c; }
  inner.set(new TextEncoder().encode(text), 64);
  outer.set(Uint8Array.from(sha256Bytes(inner).match(/../g)!, part => parseInt(part, 16)), 64);
  return sha256Bytes(outer);
}
