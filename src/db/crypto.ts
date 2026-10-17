/**
 * AES-GCM for connection secrets (Slack webhook URLs, …). A random 12-byte IV
 * per value; the key is a Worker secret (`SECRETS_KEY`, base64, 32 bytes).
 * Secrets are write-only through the API: ciphertext goes in, plaintext never
 * comes back out to a client, and neither side touches logs.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface SealedSecret {
  ciphertext: string;
  iv: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function importSecretsKey(base64Key: string): Promise<CryptoKey> {
  const raw = fromBase64(base64Key.trim());
  if (raw.length !== 32) {
    throw new Error("SECRETS_KEY must be a base64-encoded 32-byte key (openssl rand -base64 32).");
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function sealSecret(plaintext: string, key: CryptoKey): Promise<SealedSecret> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext));
  return { ciphertext: toBase64(new Uint8Array(ciphertext)), iv: toBase64(iv) };
}

export async function openSecret(sealed: SealedSecret, key: CryptoKey): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(sealed.iv) },
    key,
    fromBase64(sealed.ciphertext),
  );
  return decoder.decode(plaintext);
}

/** The only thing a client ever sees of a stored secret: a masked tail. */
export function maskTail(plaintext: string): string {
  return `…${plaintext.slice(-4)}`;
}
