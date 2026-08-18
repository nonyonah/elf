import { rgbToHex, slugify } from "../normalize.js";
import type { Token } from "../types.js";
import type { FigmaApi } from "./client.js";

interface TeamStyle {
  key: string;
  name: string;
  node_id: string;
  style_type: "FILL" | "TEXT" | "EFFECT" | "GRID";
}

interface PaintFill {
  type: string;
  color?: { r: number; g: number; b: number; a?: number };
}

interface TextStyle {
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
  lineHeightPx?: number;
  letterSpacing?: string;
}

interface StyleNode {
  styles?: { fill?: string; text?: string };
  fills?: PaintFill[];
  style?: TextStyle;
}

const NODE_CHUNK_SIZE = 50;

export async function fetchStyles(
  api: FigmaApi,
  fileKey: string,
  teamId?: string,
): Promise<Token[]> {
  if (!teamId) {
    throw new Error(
      "This Figma file uses styles (not variables). Add \"figma.teamId\" to drift-checker.config.json " +
        "so styles can be looked up via the team styles endpoint.",
    );
  }

  const { styles } = await api.get<{ styles: TeamStyle[] }>(
    `/teams/${teamId}/styles?file_key=${fileKey}`,
  );

  const relevant = styles.filter(
    (style) => style.style_type === "FILL" || style.style_type === "TEXT",
  );

  const tokens: Token[] = [];

  for (let i = 0; i < relevant.length; i += NODE_CHUNK_SIZE) {
    const chunk = relevant.slice(i, i + NODE_CHUNK_SIZE);
    const ids = chunk.map((style) => style.node_id).join(",");
    const { nodes } = await api.get<{ nodes: Record<string, { document: StyleNode }> }>(
      `/files/${fileKey}/nodes?ids=${ids}`,
    );

    for (const style of chunk) {
      const node = nodes[style.node_id]?.document;
      if (!node) continue;
      const token = styleToToken(style, node);
      if (token) tokens.push(token);
    }
  }

  return tokens;
}

function styleToToken(style: TeamStyle, node: StyleNode): Token | null {
  const name = slugify(style.name);

  if (style.style_type === "FILL") {
    const fill = node.fills?.find((fill) => fill.type === "SOLID");
    if (!fill?.color) return null;
    const { r, g, b, a = 1 } = fill.color;
    return { name, category: "color", value: rgbToHex(r, g, b, a), source: "figma" };
  }

  if (style.style_type === "TEXT" && node.style?.fontSize) {
    const text = node.style;
    const parts = [`${text.fontSize}px`];
    if (text.lineHeightPx) parts.push(`${text.lineHeightPx}px`);
    if (text.fontWeight) parts.push(String(text.fontWeight));
    if (text.fontFamily) parts.push(text.fontFamily);
    return { name, category: "typography", value: parts.join(" "), source: "figma" };
  }

  return null;
}
