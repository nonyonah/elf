/**
 * Result shapes returned by the bridge plugin's methods. These mirror the
 * payloads built in bridge-plugin/code.ts — keep the two in sync.
 */

import { z } from "zod";

export const variableTypeSchema = z.enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"]);
export type VariableType = z.infer<typeof variableTypeSchema>;

export const variableScopeSchema = z.enum([
  "ALL_SCOPES",
  "TEXT_CONTENT",
  "CORNER_RADIUS",
  "WIDTH_HEIGHT",
  "GAP",
  "ALL_FILLS",
  "FRAME_FILL",
  "SHAPE_FILL",
  "TEXT_FILL",
  "STROKE_COLOR",
  "STROKE_FLOAT",
  "EFFECT_FLOAT",
  "EFFECT_COLOR",
  "OPACITY",
  "FONT_FAMILY",
  "FONT_STYLE",
  "FONT_WEIGHT",
  "FONT_SIZE",
  "LINE_HEIGHT",
  "LETTER_SPACING",
  "PARAGRAPH_SPACING",
  "PARAGRAPH_INDENT",
]);

export interface PluginMode {
  modeId: string;
  name: string;
}

export interface PluginCollection {
  id: string;
  name: string;
  key: string | null;
  defaultModeId: string;
  modes: PluginMode[];
  variableCount: number;
}

export interface PluginVariableValue {
  type: string;
  value: unknown;
}

export interface PluginVariable {
  id: string;
  name: string;
  key: string | null;
  collectionId: string;
  collectionName: string;
  resolvedType: string;
  description: string | null;
  scopes: string[];
  codeKey: string | null;
  valuesByMode: Record<string, Record<string, unknown>>;
}

export interface PluginUpsertResult {
  id: string;
  name: string;
  action: "created" | "updated";
  resolvedType: string;
  codeKey: string | null;
  codeKeySet: boolean;
}

export interface PluginComponent {
  id: string;
  name: string;
  codeKey: string | null;
  parentId: string | null;
  width: number;
  height: number;
  layoutMode: string;
  childCount: number;
}

export interface PluginBoundVariable {
  id: string;
  name: string;
}

export interface PluginNodeFill {
  type: string;
  color: { r: number; g: number; b: number } | null;
  opacity: number;
  boundVariable: PluginBoundVariable | null;
}

export interface PluginNode {
  id: string;
  name: string;
  type: string;
  codeKey: string | null;
  layoutMode: string;
  width: number;
  height: number;
  x: number;
  y: number;
  itemSpacing: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  cornerRadius: number | string;
  fills: PluginNodeFill[];
  boundVariables: Record<string, PluginBoundVariable>;
  children: PluginNode[];
}