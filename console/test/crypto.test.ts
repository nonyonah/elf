import { describe, expect, it } from "vitest";
import { importSecretsKey, maskTail, openSecret, sealSecret } from "../src/db/crypto";

function randomKeyB64(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

const SLACK_URL = "https://hooks.slack.com/services/T000/B000/supersecret";

describe("AES-GCM connection secrets", () => {
  it("round-trips a value and keeps the plaintext out of the ciphertext", async () => {
    const key = await importSecretsKey(randomKeyB64());
    const sealed = await sealSecret(SLACK_URL, key);

    expect(sealed.ciphertext).not.toContain("hooks.slack.com");
    expect(sealed.ciphertext).not.toContain("supersecret");
    expect(sealed.iv).not.toBe("");
    await expect(openSecret(sealed, key)).resolves.toBe(SLACK_URL);
  });

  it("uses a fresh random IV per value", async () => {
    const key = await importSecretsKey(randomKeyB64());
    const first = await sealSecret(SLACK_URL, key);
    const second = await sealSecret(SLACK_URL, key);

    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("refuses another key and tampered ciphertext", async () => {
    const key = await importSecretsKey(randomKeyB64());
    const otherKey = await importSecretsKey(randomKeyB64());
    const sealed = await sealSecret(SLACK_URL, key);

    await expect(openSecret(sealed, otherKey)).rejects.toThrow();

    const tampered = { ...sealed, ciphertext: sealed.ciphertext.slice(0, -4) + "AAAA" };
    await expect(openSecret(tampered, key)).rejects.toThrow();
  });

  it("rejects keys that are not 32 bytes", async () => {
    await expect(importSecretsKey(btoa("short"))).rejects.toThrow(/32-byte/);
  });

  it("masks a stored secret down to its tail", () => {
    expect(maskTail(SLACK_URL)).toBe("…cret");
  });
});
