/**
 * Failures that happen on the way to the plugin (or on the way back) rather
 * than inside the Figma Plugin API itself. Plugin API errors are relayed
 * verbatim by design — see `BridgeRequestError` usage in bridge.ts.
 */
export type BridgeErrorCode =
  | "not-connected"
  | "timeout"
  | "disconnected"
  | "plugin"
  | "transport"
  | "auth";

export class BridgeError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export function describeError(error: unknown): string {
  if (error instanceof BridgeError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}