import type { DriftConfig, Token } from "../core/types.js";
import { fetchBridgeVariables, type BridgeCaller } from "./bridge.js";
import type { FigmaApi } from "./client.js";
import { fetchStyles } from "./styles.js";
import { fetchVariables } from "./variables.js";

export interface FigmaFetchResult {
  tokens: Token[];
  /** Which source actually answered — logged and shown in the report. */
  source: "variables" | "variables (bridge)" | "styles";
}

/**
 * Resolves the configured Figma source into tokens.
 *
 * - "variables" / "styles": the REST API, exactly as before.
 * - "bridge": the plugin via /control — works on any Figma plan.
 * - "auto": try REST variables first; fall back to the bridge when REST is
 *   blocked by a plan/permission error (or no token is set at all). An empty
 *   file still falls back to REST styles, as it always did.
 */
export async function fetchFigmaTokens(
  config: DriftConfig,
  restApi: () => FigmaApi,
  connectBridge: () => Promise<BridgeCaller>,
): Promise<FigmaFetchResult> {
  const variablesOptions = { modeName: config.modeName, modeStrategy: config.modeStrategy, collectionAwareNames:config.figma.collectionAwareNames };
  const { fileKey, teamId, source } = config.figma;

  if (source === "variables") {
    return { tokens: await fetchVariables(restApi(), fileKey, variablesOptions), source: "variables" };
  }
  if (source === "styles") {
    return { tokens: await fetchStyles(restApi(), fileKey, teamId), source: "styles" };
  }
  if (source === "bridge") {
    return { tokens: await fetchBridgeVariables(await connectBridge(), variablesOptions), source: "variables (bridge)" };
  }

  try {
    const tokens = await fetchVariables(restApi(), fileKey, variablesOptions);
    if (tokens.length > 0) return { tokens, source: "variables" };
    return { tokens: await fetchStyles(restApi(), fileKey, teamId), source: "styles" };
  } catch (error) {
    if (!isPlanOrPermissionError(error) && !isMissingTokenError(error)) throw error;
    return { tokens: await fetchBridgeVariables(await connectBridge(), variablesOptions), source: "variables (bridge)" };
  }
}

/** REST variables is Enterprise-only; Figma reports that as a 4xx with a plan hint. */
export function isPlanOrPermissionError(error: unknown): boolean {
  const message = (error as Error).message ?? "";
  const status = message.match(/Figma API returned (\d{3})/);
  if (!status) return false;
  const code = Number(status[1]);
  if (code === 402 || code === 403) return true;
  return code === 400 && /plan|enterprise|permission|entitle/i.test(message);
}

/** "auto" without a token is not an error — the bridge does not need one. */
function isMissingTokenError(error: unknown): boolean {
  return /Figma API token not found/.test((error as Error).message ?? "");
}
