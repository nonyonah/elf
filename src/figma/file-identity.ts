import { figmaAccessToken } from "./account.js";
import { readConnectionJson } from "../connection-service.js";

export interface PublicFileProof { nonce: string; }
/** A fresh document marker proves that the URL belongs to the open plugin file. */
export async function verifyPublicFile(key: string, proof: PublicFileProof, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(key) || !proof || !/^[a-f0-9]{64}$/.test(proof.nonce)) throw new Error("Invalid Figma file verification request.");
  const token = await figmaAccessToken();
  const url = new URL(`https://api.figma.com/v1/files/${encodeURIComponent(key)}`);
  url.search = new URLSearchParams({depth: "1", plugin_data: "shared"}).toString();
  const signal = AbortSignal.timeout(15_000);
  for (const delay of [0, 750, 1500, 3000]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    signal.throwIfAborted();
    const response = await fetchImpl(url, {headers: {Authorization: `Bearer ${token}`}, redirect: "error", signal});
    if (!response.ok) throw new Error("Figma could not verify this file. Check account access and retry after the file saves.");
    const body = await readConnectionJson(response, 2 * 1024 * 1024) as {document?: {sharedPluginData?: {elf?: {fileProof?: string}}}};
    if (body.document?.sharedPluginData?.elf?.fileProof === proof.nonce) return;
  }
  throw new Error("The file link does not match the open Figma document, or its proof has not saved yet.");
}
