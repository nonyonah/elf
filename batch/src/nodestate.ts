import { hashSpec } from "./manifest.js";

/**
 * Depth used for every get_node call that feeds a node hash. The writer
 * (sync, right after upserting) and the reader (elf's component diff, later)
 * must ask for the same shape, so it lives next to the hash itself.
 */
export const NODE_STATE_DEPTH = 2;

/**
 * A position-independent signature of a Figma node's state: everything
 * get_node returns except x/y, so dragging a component around the canvas is
 * not drift. Stored as `nodeHash` on every sync; when elf re-reads the node
 * and the hashes differ, the node changed in Figma.
 */
export function nodeStateHash(node: unknown): string {
  return hashSpec(stripPosition(node));
}

function stripPosition(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPosition);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === "x" || key === "y") continue;
      out[key] = stripPosition(entry);
    }
    return out;
  }
  return value;
}
