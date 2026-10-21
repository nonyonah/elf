/**
 * Figma file references. The console asks for the file URL (not a bare key),
 * so the key and a human-readable name can both be read straight from it:
 *   https://www.figma.com/design/<key>/<File-name-with-dashes>
 * The name from the slug is a fallback; when an API token is available the
 * Files endpoint supplies the authoritative name.
 */
const FIGMA_FILES_API = "https://api.figma.com/v1/files";

const URL_PATTERN =
  /figma\.com\/(?:file|design|proto|board)\/([A-Za-z0-9]+)(?:\/([^/?#]+))?/i;
const KEY_PATTERN = /^[A-Za-z0-9]{6,100}$/;

export interface FigmaRef {
  fileKey: string;
  fileName: string | null;
}

function nameFromSlug(slug: string | undefined): string | null {
  if (!slug) return null;
  try {
    const decoded = decodeURIComponent(slug).replace(/-+/g, " ").trim();
    return decoded || null;
  } catch {
    const decoded = slug.replace(/-+/g, " ").trim();
    return decoded || null;
  }
}

/** Accepts a full Figma URL or a bare file key (kept for older callers). */
export function parseFigmaRef(input: string): FigmaRef | null {
  const value = input.trim();
  if (!value) return null;
  const match = URL_PATTERN.exec(value);
  if (match) {
    return { fileKey: match[1], fileName: nameFromSlug(match[2]) };
  }
  if (KEY_PATTERN.test(value)) return { fileKey: value, fileName: null };
  return null;
}

export function figmaFileUrl(fileKey: string): string {
  return `https://www.figma.com/file/${fileKey}`;
}

export async function fetchFigmaFileName(
  fileKey: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetchImpl(
      `${FIGMA_FILES_API}/${encodeURIComponent(fileKey)}?depth=1`,
      { headers: { "X-Figma-Token": token } },
    );
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as {
      name?: unknown;
    } | null;
    return typeof body?.name === "string" && body.name ? body.name : null;
  } catch {
    return null;
  }
}
