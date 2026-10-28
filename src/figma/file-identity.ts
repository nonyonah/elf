import { figmaAccessToken } from "./account.js";
import { readConnectionJson } from "../connection-service.js";
import { readVerificationLimit, storeVerificationLimit, verificationLimitMessage } from './verification-limit.js';

export interface PublicFileProof { nonce: string; }
/** Fixed, credential-free messages safe to display in the plugin. */
export class FileVerificationError extends Error {}
/** A fresh document marker proves that the URL belongs to the open plugin file. */
export async function verifyPublicFile(key: string, proof: PublicFileProof, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(key) || !proof || !/^[a-f0-9]{64}$/.test(proof.nonce)) throw new Error("Invalid Figma file verification request.");
  const limit = readVerificationLimit(key);
  if (limit) throw new FileVerificationError(verificationLimitMessage(limit));
  let token: string;
  try {token = await figmaAccessToken();}
  catch {throw new FileVerificationError("Figma account unavailable. Reconnect Figma in Elf Settings, then retry.");}
  const url = new URL(`https://api.figma.com/v1/files/${encodeURIComponent(key)}`);
  url.search = new URLSearchParams({depth: "1", plugin_data: "shared"}).toString();
  const signal = AbortSignal.timeout(15_000);
  let renewed = false;
  for (const delay of [0, 750, 1500, 3000]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    signal.throwIfAborted();
    const request = () => fetchImpl(url, {headers: {Authorization: `Bearer ${token}`}, redirect: "error", signal});
    let response = await request();
    // Figma keeps one access token per app/user. A token can stop working before
    // its recorded expiry when another connection refreshes it. Renew only once;
    // permission failures must still fail closed after the retry.
    if ((response.status === 401 || response.status === 403) && !renewed) {
      renewed = true; await response.body?.cancel();
      try {token = await figmaAccessToken(true);}
      catch {throw new FileVerificationError("Figma account renewal failed. Reconnect Figma in Elf Settings.");}
      response = await request();
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429) {
        const pending = storeVerificationLimit(key, response.headers);
        throw new FileVerificationError(verificationLimitMessage(pending));
      }
      if (response.status === 401 || response.status === 403) throw new FileVerificationError("Figma denied file access. Check app scope/account access, then reconnect Figma in Settings.");
      if (response.status === 404) throw new FileVerificationError("Figma file not found. Check the file link and your account access.");
      throw new FileVerificationError("Figma could not verify the file. Retry after the file saves.");
    }
    const body = await readConnectionJson(response, 2 * 1024 * 1024) as {document?: {sharedPluginData?: {elf?: {fileProof?: string}}}};
    if (body.document?.sharedPluginData?.elf?.fileProof === proof.nonce) return;
  }
  throw new FileVerificationError("The file link does not match the open Figma document, or its proof has not saved yet.");
}
