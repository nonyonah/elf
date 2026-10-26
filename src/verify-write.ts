import { stableStringify } from "../batch/src/manifest.js";
import { cssColorToHex } from "./core/normalize.js";

function color(value: any): string | null {
  if (value && typeof value === "object" && "r" in value) return cssColorToHex(`rgba(${value.r * 255},${value.g * 255},${value.b * 255},${value.a ?? 1})`);
  return cssColorToHex(String(value));
}
/** Check only fields the description asked us to write; omitted fields are preserved. */
export function verifyComponentPatch(params: Record<string, any>, node: any, variables: any[], components: any[]): void {
  if (!node) throw new Error("The written component could not be read back.");
  const fail = () => { throw new Error(`${params.name ?? "Component"}: Figma changed while syncing or the requested fields could not be verified. Review before retrying.`); };
  const referenceMatches = (reference: string, binding: any): boolean => variables.some(item => (item.name === reference || `${item.collectionName}/${item.name}` === reference || item.id === reference) && item.id === binding?.id);
  const number = (expected: any, actual: any, field: string) => {
    if (expected === undefined) return;
    if (expected && typeof expected === "object" && expected.variable) { if (!referenceMatches(expected.variable, node.boundVariables?.[field])) fail(); }
    else if (actual !== expected) fail();
  };
  if (params.layoutMode !== undefined && node.layoutMode !== params.layoutMode) fail();
  number(params.gap, node.itemSpacing, "itemSpacing"); number(params.cornerRadius, node.cornerRadius, "cornerRadius");
  if (params.size) { number(params.size.width, node.width, "width"); number(params.size.height, node.height, "height"); }
  for (const side of ["Top", "Right", "Bottom", "Left"]) number(params.padding?.[side.toLowerCase()] ?? params.padding?.all, node[`padding${side}`], `padding${side}`);
  for (const [input, output] of [[params.fill, node.fills], [params.stroke?.color, node.strokes]]) if (input) {
    if (!output?.[0]) fail();
    if (input.variable ? !referenceMatches(input.variable, output[0].boundVariable) : color(input.color) !== color({ ...output[0].color, a: output[0].opacity ?? 1 })) fail();
  }
  number(params.stroke?.weight, node.strokeWeight, "strokeWeight");
  if (params.text) {
    const text = node.children?.find((child: any) => child.type === "TEXT");
    if (!text || text.characters !== params.text.characters) fail();
    if (params.text.fontSize !== undefined && text.fontSize !== params.text.fontSize) fail();
    if (params.text.color) verifyComponentPatch({ fill: params.text.color }, text, variables, components);
    if (params.text.fontStyle !== undefined && text.fontName?.style !== params.text.fontStyle) fail();
    if (params.text.fontFamily !== undefined && text.fontName?.family !== params.text.fontFamily) fail();
  }
  if (params.children) {
    const instances = node.children?.filter((child: any) => child.type === "INSTANCE") ?? [];
    if (instances.length !== params.children.length) fail();
    params.children.forEach((child: any, index: number) => {
      const target = components.find(item => item.codeKey === child.component);
      if (!target || instances[index]?.mainComponentId !== target.id) fail();
    });
  }
}

export function verifyStylePatch(kind: "text" | "effect", params: Record<string, any>, actual: any): void {
  const fail = () => { throw new Error(`${params.name ?? "Style"}: the Figma style changed while syncing or could not be verified.`); };
  if (!actual) fail();
  if (kind === "text") {
    if (params.fontFamily !== undefined && params.fontFamily !== actual.fontName?.family) fail();
    if (params.fontStyle !== undefined && params.fontStyle !== actual.fontName?.style) fail();
    if (params.fontSize !== undefined && params.fontSize !== actual.fontSize) fail();
    for (const field of ["lineHeight", "letterSpacing"]) if (params[field] !== undefined) {
      const desired = params[field]; const value = actual[field];
      if (desired === "auto") { if (value?.unit !== "AUTO") fail(); }
      else if (typeof desired === "number") { if (value?.unit !== "PIXELS" || value?.value !== desired) fail(); }
      else if (desired.percent !== undefined && (value?.unit !== "PERCENT" || value.value !== desired.percent)) fail();
    }
  } else {
    if (!Array.isArray(actual.effects) || actual.effects.length !== params.effects.length) fail();
    params.effects.forEach((effect: Record<string, any>, index: number) => {
      for (const [field, value] of Object.entries(effect)) {
        if (field === "color") { if (color(value) !== color(actual.effects[index]?.color)) fail(); }
        else if (stableStringify(value) !== stableStringify(actual.effects[index]?.[field])) fail();
      }
    });
  }
}
