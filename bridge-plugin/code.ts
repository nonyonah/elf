/**
 * Elf Bridge — plugin main thread.
 *
 * The main thread has no network access, so the UI iframe owns the WebSocket
 * and relays `{ type: "request", id, method, params }` in here over
 * postMessage. Every answer carries the same `id` back.
 *
 * Only the Figma Plugin API is used — never the REST Variables API, which is
 * Enterprise-only. Everything therefore works on a free/Professional plan.
 */

const PLUGIN_NAME = "Elf Bridge";
const SETTINGS_KEY = "elf-bridge-settings";
const NAMESPACE = "elf";
const CODE_KEY = "codeKey";
const ROLE_KEY = "role";
const LABEL_ROLE = "label";
const DEFAULT_HOST = "localhost:8765";

interface Settings {
  /** `host:port`, or a full http(s)/ws(s) URL (e.g. an ngrok tunnel). */
  host: string;
  token: string;
}

interface UiRequest {
  type: "request";
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface UiMessage {
  type: string;
  [key: string]: unknown;
}

type ColorChannels = { r: number; g: number; b: number; a?: number };

type VariableValueInput = string | number | boolean | ColorChannels | { variable: string };

interface VariableSpec {
  name: string;
  type?: VariableResolvedDataType;
  codeKey?: string;
  description?: string;
  mode?: string;
  scopes?: VariableScope[];
  values: Record<string, VariableValueInput>;
}

/** A literal number, or a FLOAT variable to bind instead. */
type NumberOrRef = number | { variable: string };

interface PaddingInput {
  all?: NumberOrRef;
  top?: NumberOrRef;
  right?: NumberOrRef;
  bottom?: NumberOrRef;
  left?: NumberOrRef;
}

/** A literal colour, or a COLOR variable to bind instead. */
interface FillInput {
  color?: string;
  opacity?: number;
  variable?: string;
}

interface TextInput {
  characters: string;
  fontFamily?: string;
  fontStyle?: string;
  fontSize?: number;
  color?: FillInput;
}

interface ComponentInput {
  name: string;
  codeKey?: string;
  parentId?: string;
  layoutMode?: "HORIZONTAL" | "VERTICAL" | "NONE";
  padding?: PaddingInput;
  gap?: NumberOrRef;
  cornerRadius?: NumberOrRef;
  fill?: FillInput;
  size?: { width: number; height: number };
  text?: TextInput;
}

interface LayoutNode {
  layoutMode: "NONE" | "HORIZONTAL" | "VERTICAL" | "GRID";
  itemSpacing: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  cornerRadius: number | PluginAPI["mixed"];
  setBoundVariable(field: VariableBindableNodeField, variable: Variable | null): void;
}

// ---------------------------------------------------------------------------
// Settings — kept in clientStorage, never in the document or the repo.
// ---------------------------------------------------------------------------

async function loadSettings(): Promise<Settings> {
  const stored = (await figma.clientStorage.getAsync(SETTINGS_KEY)) as Partial<Settings> | undefined;
  return { host: stored?.host?.trim() || DEFAULT_HOST, token: stored?.token ?? "" };
}

async function saveSettings(settings: Settings): Promise<void> {
  await figma.clientStorage.setAsync(SETTINGS_KEY, settings);
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

async function localCollections(): Promise<VariableCollection[]> {
  return figma.variables.getLocalVariableCollectionsAsync();
}

function collectionPayload(collection: VariableCollection): Record<string, unknown> {
  return {
    id: collection.id,
    name: collection.name,
    key: collection.key ?? null,
    defaultModeId: collection.defaultModeId,
    modes: collection.modes.map((mode) => ({ modeId: mode.modeId, name: mode.name })),
    variableCount: collection.variableIds.length,
  };
}

async function findCollection(nameOrId: string): Promise<VariableCollection> {
  const collections = await localCollections();
  const found = collections.find((collection) => collection.name === nameOrId || collection.id === nameOrId);
  if (found) return found;

  const available = collections.map((collection) => collection.name).join(", ") || "none";
  throw new Error(`Variable collection "${nameOrId}" not found. Available: ${available}.`);
}

function findMode(
  collection: VariableCollection,
  key: string,
): { modeId: string; name: string } | null {
  const byName = collection.modes.find((mode) => mode.name === key || mode.modeId === key);
  if (byName) return byName;
  const lower = key.toLowerCase();
  return collection.modes.find((mode) => mode.name.toLowerCase() === lower) ?? null;
}

function defaultMode(collection: VariableCollection): { modeId: string; name: string } {
  const mode = collection.modes.find((candidate) => candidate.modeId === collection.defaultModeId);
  if (!mode) throw new Error(`Variable collection "${collection.name}" has no modes.`);
  return mode;
}

function codeKeyOf(target: { getSharedPluginData(namespace: string, key: string): string }): string | null {
  return target.getSharedPluginData(NAMESPACE, CODE_KEY) || null;
}

function tagCodeKey(target: { setSharedPluginData(namespace: string, key: string, value: string): void }, codeKey: string): void {
  if (!codeKey) return;
  target.setSharedPluginData(NAMESPACE, CODE_KEY, codeKey);
}

function colorToHex(color: ColorChannels): string {
  const channel = (value: number): string =>
    Math.round(Math.min(1, Math.max(0, value)) * 255)
      .toString(16)
      .padStart(2, "0");
  const alpha = color.a ?? 1;
  const hex = `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
  return alpha >= 0.995 ? hex : `${hex}${channel(alpha)}`;
}

/** Accepts #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba(). Channels are 0–255. */
function parseColor(input: string): ColorChannels {
  const value = input.trim();

  if (value.startsWith("#")) {
    const hex = value.slice(1);
    const expanded = /^[0-9a-f]{3,4}$/i.test(hex)
      ? hex
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : hex;
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(expanded)) {
      throw new Error(`Invalid hex colour "${input}". Use #rgb, #rgba, #rrggbb or #rrggbbaa.`);
    }
    return {
      r: parseInt(expanded.slice(0, 2), 16) / 255,
      g: parseInt(expanded.slice(2, 4), 16) / 255,
      b: parseInt(expanded.slice(4, 6), 16) / 255,
      a: expanded.length === 8 ? parseInt(expanded.slice(6, 8), 16) / 255 : 1,
    };
  }

  const match = value.match(/^rgba?\(([^)]+)\)$/i);
  if (match) {
    const parts = match[1].split(",").map((part) => Number(part.trim()));
    if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) {
      throw new Error(`Invalid rgb colour "${input}". Use rgb(255, 99, 102) or { r, g, b, a } with 0–1 channels.`);
    }
    return { r: parts[0] / 255, g: parts[1] / 255, b: parts[2] / 255, a: parts.length > 3 ? parts[3] : 1 };
  }

  throw new Error(`Unsupported colour "${input}". Use hex, rgb(), or { r, g, b, a } with 0–1 channels.`);
}

function isColorLike(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value.trim()) || /^rgba?\([^)]+\)$/i.test(value.trim());
}

function isAlias(value: unknown): value is { variable: string } {
  return typeof value === "object" && value !== null && typeof (value as { variable?: unknown }).variable === "string";
}

function isChannels(value: unknown): value is ColorChannels {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ColorChannels).r === "number" &&
    typeof (value as ColorChannels).g === "number" &&
    typeof (value as ColorChannels).b === "number"
  );
}

function inferType(value: VariableValueInput): VariableResolvedDataType | null {
  if (isAlias(value)) return null;
  if (isChannels(value)) return "COLOR";
  if (typeof value === "number") return "FLOAT";
  if (typeof value === "boolean") return "BOOLEAN";
  if (isColorLike(value)) return "COLOR";
  if (typeof value === "string") return "STRING";
  return null;
}

async function resolveVariable(nameOrId: string): Promise<Variable> {
  const variables = await figma.variables.getLocalVariablesAsync();
  if (nameOrId.includes(":")) {
    const byId = variables.find((variable) => variable.id === nameOrId);
    if (byId) return byId;
  }

  const slash = nameOrId.indexOf("/");
  if (slash > 0) {
    const collectionName = nameOrId.slice(0, slash);
    const variableName = nameOrId.slice(slash + 1);
    const collection = (await localCollections()).find((candidate) => candidate.name === collectionName);
    const scoped = collection
      ? variables.find((variable) => variable.name === variableName && variable.variableCollectionId === collection.id)
      : undefined;
    if (scoped) return scoped;
  }

  const exact = variables.filter((variable) => variable.name === nameOrId);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    const names = exact.map((variable) => variable.name).join(", ");
    throw new Error(`Variable "${nameOrId}" is ambiguous (${names}). Use "collection/name" or the variable id.`);
  }

  throw new Error(`Variable "${nameOrId}" not found in this file.`);
}

async function toFigmaValue(type: VariableResolvedDataType, value: VariableValueInput): Promise<VariableValue> {
  if (isAlias(value)) {
    const target = await resolveVariable(value.variable);
    if (target.resolvedType !== type) {
      throw new Error(
        `Variable "${value.variable}" is ${target.resolvedType}, but this variable is ${type}.`,
      );
    }
    return figma.variables.createVariableAlias(target);
  }

  if (type === "COLOR") {
    if (isChannels(value)) return value;
    if (typeof value === "string") return parseColor(value);
    throw new Error(`Expected a colour, got ${typeof value}.`);
  }

  if (type === "FLOAT") {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) throw new Error(`Expected a number for a FLOAT variable, got "${String(value)}".`);
    return numeric;
  }

  if (type === "BOOLEAN") {
    if (typeof value !== "boolean") throw new Error(`Expected true/false for a BOOLEAN variable, got "${String(value)}".`);
    return value;
  }

  return String(value);
}

function isAliasValue(value: unknown): value is VariableAlias {
  return typeof value === "object" && value !== null && (value as VariableAlias).type === "VARIABLE_ALIAS";
}

async function variablePayload(variable: Variable): Promise<Record<string, unknown>> {
  const collections = await localCollections();
  const collection = collections.find((candidate) => candidate.id === variable.variableCollectionId);
  const valuesByMode: Record<string, unknown> = {};

  for (const mode of collection?.modes ?? []) {
    const entry = variable.valuesByMode[mode.modeId];
    if (entry === undefined) continue;

    if (isAliasValue(entry)) {
      const target = await figma.variables.getVariableByIdAsync(entry.id);
      valuesByMode[mode.name] = { modeId: mode.modeId, type: "VARIABLE_ALIAS", id: entry.id, name: target?.name ?? null };
      continue;
    }
    if (isChannels(entry)) {
      valuesByMode[mode.name] = { modeId: mode.modeId, type: "COLOR", value: colorToHex(entry) };
      continue;
    }
    valuesByMode[mode.name] = { modeId: mode.modeId, type: variable.resolvedType, value: entry };
  }

  return {
    id: variable.id,
    name: variable.name,
    key: variable.key ?? null,
    collectionId: variable.variableCollectionId,
    collectionName: collection?.name ?? "",
    resolvedType: variable.resolvedType,
    description: variable.description || null,
    scopes: variable.scopes,
    codeKey: codeKeyOf(variable),
    valuesByMode,
  };
}

async function listCollections(): Promise<unknown> {
  const collections = await localCollections();
  return { collections: collections.map(collectionPayload) };
}

async function listVariables(params: Record<string, unknown>): Promise<unknown> {
  const collection = params.collection ? await findCollection(String(params.collection)) : null;
  const type = params.type ? (String(params.type) as VariableResolvedDataType) : undefined;
  const variables = await figma.variables.getLocalVariablesAsync(type);

  const scoped = collection
    ? variables.filter((variable) => variable.variableCollectionId === collection.id)
    : variables;

  return { variables: await Promise.all(scoped.map((variable) => variablePayload(variable))) };
}

async function createCollection(params: Record<string, unknown>): Promise<unknown> {
  const name = String(params.name ?? "").trim();
  if (!name) throw new Error("A collection name is required.");

  const existing = (await localCollections()).find((collection) => collection.name === name);
  if (existing) {
    for (const mode of (params.modes as string[] | undefined) ?? []) addMissingMode(existing, mode);
    return { collection: collectionPayload(existing), created: false };
  }

  const collection = figma.variables.createVariableCollection(name);
  // A new collection ships with one default mode; rename it to the first name
  // the caller asked for so the result is exactly the mode list they gave.
  let first = true;
  for (const mode of (params.modes as string[] | undefined) ?? []) {
    if (first) {
      const target = defaultMode(collection);
      if (target.name !== mode) collection.renameMode(target.modeId, mode);
      first = false;
      continue;
    }
    addMissingMode(collection, mode);
  }

  return { collection: collectionPayload(collection), created: true };
}

function addMissingMode(collection: VariableCollection, modeName: string): void {
  if (!modeName) return;
  if (findMode(collection, modeName)) return;
  // Plan limits surface here as Figma's own error, relayed untouched.
  collection.addMode(modeName);
}

async function upsertVariables(params: Record<string, unknown>): Promise<unknown> {
  const collection = await findCollection(String(params.collection ?? ""));
  const specs = (params.variables as VariableSpec[] | undefined) ?? [];
  const fallbackKey = params.defaultMode ? String(params.defaultMode) : null;
  if (fallbackKey && !findMode(collection, fallbackKey)) {
    throw new Error(
      `Unknown mode "${fallbackKey}" in collection "${collection.name}". ` +
        `Modes: ${collection.modes.map((mode) => mode.name).join(", ")}.`,
    );
  }

  const byName = new Map<string, Variable>();
  for (const variable of await figma.variables.getLocalVariablesAsync()) {
    if (variable.variableCollectionId === collection.id) byName.set(variable.name, variable);
  }

  const results: Record<string, unknown>[] = [];
  const errors: { name: string; message: string }[] = [];

  for (const spec of specs) {
    const name = String(spec?.name ?? "").trim();
    try {
      if (!name) throw new Error("A variable name is required.");

      const values = spec.values ?? {};
      const firstValue = Object.values(values)[0];
      if (firstValue === undefined) throw new Error(`Variable "${name}" has no values.`);

      const type = spec.type ?? inferType(firstValue) ?? (await aliasType(firstValue));
      const existing = byName.get(name);
      if (existing && existing.resolvedType !== type) {
        throw new Error(
          `Variable "${name}" already exists with type ${existing.resolvedType}; Figma types cannot change.`,
        );
      }

      // Resolve modes and convert every value before touching Figma: a
      // rejected item must not leave a half-written variable behind.
      const fallback = spec.mode
        ? findMode(collection, spec.mode)
        : fallbackKey
          ? findMode(collection, fallbackKey)
          : defaultMode(collection);
      if (spec.mode && !fallback) {
        throw new Error(
          `Unknown mode "${spec.mode}" in collection "${collection.name}". ` +
            `Modes: ${collection.modes.map((mode) => mode.name).join(", ")}.`,
        );
      }

      const prepared: { modeId: string; value: VariableValue }[] = [];
      for (const [key, value] of Object.entries(values)) {
        const mode = findMode(collection, key) ?? fallback;
        if (!mode) throw new Error(`No mode to write "${key}" for variable "${name}".`);
        prepared.push({ modeId: mode.modeId, value: await toFigmaValue(type, value) });
      }

      const variable = existing ?? figma.variables.createVariable(name, collection, type);
      if (!existing) byName.set(name, variable);

      if (spec.description !== undefined) variable.description = String(spec.description);
      if (spec.scopes) variable.scopes = spec.scopes;
      tagCodeKey(variable, String(spec.codeKey ?? ""));

      for (const entry of prepared) variable.setValueForMode(entry.modeId, entry.value);

      results.push({
        id: variable.id,
        name: variable.name,
        action: existing ? "updated" : "created",
        resolvedType: variable.resolvedType,
        codeKey: codeKeyOf(variable),
        codeKeySet: codeKeyOf(variable) !== null,
      });
    } catch (error) {
      errors.push({ name, message: (error as Error).message });
    }
  }

  return { collection: collectionPayload(collection), variables: results, errors };
}

async function aliasType(value: VariableValueInput): Promise<VariableResolvedDataType> {
  if (!isAlias(value)) throw new Error(`Cannot infer a type for ${JSON.stringify(value)} — pass "type".`);
  return (await resolveVariable(value.variable)).resolvedType;
}

async function renameVariable(params: Record<string, unknown>): Promise<unknown> {
  const newName = String(params.newName ?? "").trim();
  if (!newName) throw new Error("A new name is required.");

  let collection: VariableCollection | undefined = params.collection
    ? await findCollection(String(params.collection))
    : undefined;

  const all = await figma.variables.getLocalVariablesAsync();
  const target = params.id
    ? all.find((variable) => variable.id === params.id)
    : all.find((variable) => variable.name === params.name);
  if (!target) {
    throw new Error(`Variable "${String(params.name ?? params.id)}" not found in this file.`);
  }
  if (!collection) {
    collection = (await localCollections()).find((candidate) => candidate.id === target.variableCollectionId);
  }

  const clash = collection?.variableIds
    .map((id) => all.find((variable) => variable.id === id))
    .find((variable) => variable && variable.id !== target.id && variable.name === newName);
  if (clash) throw new Error(`"${newName}" already exists in collection "${collection?.name}".`);

  const previousName = target.name;
  target.name = newName;

  return {
    renamed: {
      id: target.id,
      previousName,
      name: target.name,
      collectionId: target.variableCollectionId,
      collectionName: collection?.name ?? "",
    },
  };
}

async function deleteVariables(params: Record<string, unknown>): Promise<unknown> {
  const collection = params.collection ? await findCollection(String(params.collection)) : null;
  const all = await figma.variables.getLocalVariablesAsync();
  const inScope = (variable: Variable): boolean => !collection || variable.variableCollectionId === collection.id;

  const deleted: { id: string; name: string }[] = [];
  const missing: string[] = [];
  const remove = (variable: Variable | undefined, label: string): void => {
    if (!variable) {
      missing.push(label);
      return;
    }
    const name = variable.name;
    variable.remove();
    deleted.push({ id: variable.id, name });
  };

  for (const id of (params.ids as string[] | undefined) ?? []) {
    remove(all.find((variable) => variable.id === id && inScope(variable)), String(id));
  }
  for (const name of (params.names as string[] | undefined) ?? []) {
    remove(
      all.find((variable) => variable.name === name && inScope(variable) && !deleted.some((entry) => entry.name === name)),
      String(name),
    );
  }

  return { deleted, missing };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

type Fillable = { fills: ReadonlyArray<Paint> | PluginAPI["mixed"] };
type ParentNode = ChildrenMixin & { id: string };

async function resolveParent(parentId?: unknown): Promise<ParentNode> {
  if (parentId) {
    const node = await figma.getNodeByIdAsync(String(parentId));
    if (!node) throw new Error(`Parent node ${String(parentId)} not found in this file.`);
    if (!("appendChild" in node)) {
      throw new Error(`Node ${node.id} (${node.type}) cannot contain children.`);
    }
    return node as unknown as ParentNode;
  }
  return figma.currentPage;
}

function eachChild(parent: ChildrenMixin, visit: (child: SceneNode) => boolean): boolean {
  for (const child of parent.children) {
    if (visit(child)) return true;
  }
  return false;
}

function findDeep(parent: ChildrenMixin, predicate: (node: SceneNode) => boolean): SceneNode | null {
  if (eachChild(parent, predicate)) {
    const match = parent.children.find((child) => predicate(child));
    return match ?? null;
  }
  for (const child of parent.children) {
    if (!("children" in child)) continue;
    const found = findDeep(child as ChildrenMixin, predicate);
    if (found) return found;
  }
  return null;
}

/** Upsert key: the codeKey tag wins, then the component name. */
function findComponent(parent: ChildrenMixin, name: string, codeKey: string): ComponentNode | null {
  if (codeKey) {
    const tagged = findDeep(parent, (node) => node.type === "COMPONENT" && codeKeyOf(node) === codeKey);
    if (tagged) return tagged as ComponentNode;
  }
  const direct = parent.children.find((child) => child.type === "COMPONENT" && child.name === name);
  if (direct) return direct as ComponentNode;
  return (findDeep(parent, (node) => node.type === "COMPONENT" && node.name === name) as ComponentNode) ?? null;
}

async function requireFloatVariable(nameOrId: string, field: string): Promise<Variable> {
  const variable = await resolveVariable(nameOrId);
  if (variable.resolvedType !== "FLOAT") {
    throw new Error(`Variable "${nameOrId}" is ${variable.resolvedType}, but "${field}" needs a FLOAT variable.`);
  }
  return variable;
}

/** A number stays literal; a `{ variable }` becomes a FLOAT binding. */
type PreparedNumber = { literal: number | null; variable: Variable | null };

async function prepareNumber(value: NumberOrRef, field: string): Promise<PreparedNumber> {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`"${field}" must be a finite number.`);
    return { literal: value, variable: null };
  }
  return { literal: null, variable: await requireFloatVariable(String(value.variable), field) };
}

type PreparedFill = { paint: SolidPaint; variable: Variable | null };

async function prepareFill(fill: FillInput): Promise<PreparedFill> {
  if (fill.variable) {
    const variable = await resolveVariable(String(fill.variable));
    if (variable.resolvedType !== "COLOR") {
      throw new Error(`Variable "${fill.variable}" is ${variable.resolvedType}, but a fill needs a COLOR variable.`);
    }
    // Keep a literal colour under the binding so the node still renders.
    const fallback: SolidPaint = { type: "SOLID", color: parseColor(String(fill.color ?? "#000000")) };
    return { paint: figma.variables.setBoundVariableForPaint(fallback, "color", variable), variable };
  }

  if (!fill.color) throw new Error("A fill needs either `color` (hex or rgb) or `variable`.");
  const opacity = fill.opacity === undefined ? undefined : Number(fill.opacity);
  return {
    paint: { type: "SOLID", color: parseColor(String(fill.color)), ...(opacity === undefined ? {} : { opacity }) },
    variable: null,
  };
}

async function applyFill(target: Fillable, fill: FillInput): Promise<{ variableId: string; variableName: string } | null> {
  const prepared = await prepareFill(fill);
  target.fills = [prepared.paint];
  return prepared.variable ? { variableId: prepared.variable.id, variableName: prepared.variable.name } : null;
}

async function upsertLabel(component: ComponentNode, text: TextInput): Promise<TextNode> {
  const family = String(text.fontFamily ?? "Inter");
  const style = String(text.fontStyle ?? "Regular");
  // Figma refuses font changes until the font is loaded.
  await figma.loadFontAsync({ family, style });

  const existing =
    component.children.find(
      (child) => child.type === "TEXT" && child.getSharedPluginData(NAMESPACE, ROLE_KEY) === LABEL_ROLE,
    ) ?? component.children.find((child) => child.type === "TEXT");

  const label = (existing as TextNode | undefined) ?? figma.createText();
  if (!existing) {
    component.appendChild(label);
    label.setSharedPluginData(NAMESPACE, ROLE_KEY, LABEL_ROLE);
  }

  label.fontName = { family, style };
  label.characters = String(text.characters ?? "");
  if (text.fontSize !== undefined) label.fontSize = Number(text.fontSize);
  if (text.color) await applyFill(label, text.color);

  return label;
}

async function upsertComponent(params: Record<string, unknown>): Promise<unknown> {
  const input = params as unknown as ComponentInput;
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("A component name is required.");

  const parent = await resolveParent(input.parentId);
  const codeKey = input.codeKey ? String(input.codeKey) : "";
  const existing = findComponent(parent, name, codeKey);

  // Everything that can fail is resolved before a node is created, so a
  // rejected call leaves no empty component behind.
  const layoutMode = input.layoutMode ?? existing?.layoutMode ?? "NONE";
  if ((input.gap !== undefined || input.padding !== undefined) && layoutMode === "NONE") {
    throw new Error('`gap` and `padding` need auto layout — pass layoutMode "VERTICAL" or "HORIZONTAL".');
  }

  const fields = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const;
  const preparedPadding = [];
  if (input.padding) {
    const sides = ["top", "right", "bottom", "left"] as const;
    for (const [index, side] of sides.entries()) {
      const value = input.padding[side] ?? input.padding.all;
      if (value === undefined) continue;
      preparedPadding.push({ field: fields[index], value: await prepareNumber(value, fields[index]) });
    }
  }
  const preparedGap = input.gap === undefined ? null : await prepareNumber(input.gap, "itemSpacing");
  const preparedRadius =
    input.cornerRadius === undefined ? null : await prepareNumber(input.cornerRadius, "cornerRadius");
  const preparedFill = input.fill ? await prepareFill(input.fill) : null;
  if (input.text) {
    const family = String(input.text.fontFamily ?? "Inter");
    // Figma refuses font writes until the font is loaded; doing it here keeps
    // the component itself untouched when the family is unavailable.
    await figma.loadFontAsync({ family, style: String(input.text.fontStyle ?? "Regular") });
  }

  let component: ComponentNode;
  let created = false;
  if (existing) {
    component = existing;
  } else {
    component = figma.createComponent();
    parent.appendChild(component);
    created = true;
  }

  component.name = name;
  tagCodeKey(component, codeKey);
  if (input.layoutMode) component.layoutMode = input.layoutMode;

  const bound: Record<string, { variableId: string; variableName: string }> = {};
  const write = (
    field: (typeof fields)[number] | "itemSpacing" | "cornerRadius",
    prepared: PreparedNumber,
  ): void => {
    const target = component as unknown as LayoutNode;
    target.setBoundVariable(field, prepared.variable);
    if (prepared.literal !== null) (target as unknown as Record<string, number>)[field] = prepared.literal;
    if (prepared.variable) bound[field] = { variableId: prepared.variable.id, variableName: prepared.variable.name };
  };

  for (const entry of preparedPadding) write(entry.field, entry.value);
  if (preparedGap) write("itemSpacing", preparedGap);
  if (preparedRadius) write("cornerRadius", preparedRadius);

  if (preparedFill) {
    component.fills = [preparedFill.paint];
    if (preparedFill.variable) {
      bound.fills = { variableId: preparedFill.variable.id, variableName: preparedFill.variable.name };
    }
  }

  if (input.size) {
    const width = Number(input.size.width);
    const height = Number(input.size.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error("`size` needs finite width and height.");
    component.resize(width, height);
  }

  let label: TextNode | null = null;
  if (input.text) label = await upsertLabel(component, input.text);

  return {
    component: {
      id: component.id,
      name: component.name,
      codeKey: codeKeyOf(component),
      created,
      layoutMode: component.layoutMode,
      width: component.width,
      height: component.height,
      parentId: parent.id,
      childCount: component.children.length,
    },
    boundVariables: bound,
    text: label ? { id: label.id, characters: label.characters } : null,
  };
}

async function listComponents(params: Record<string, unknown>): Promise<unknown> {
  const parent = await resolveParent(params.parentId);
  const deep = params.deep === true;

  const components: SceneNode[] = [];
  const collect = (node: ChildrenMixin): void => {
    for (const child of node.children) {
      if (child.type === "COMPONENT") components.push(child);
      if (deep && "children" in child) collect(child as ChildrenMixin);
    }
  };
  collect(parent);

  return {
    parentId: parent.id,
    components: components.map((component) => ({
      id: component.id,
      name: component.name,
      codeKey: codeKeyOf(component),
      parentId: component.parent ? (component.parent as { id: string }).id : null,
      width: component.width,
      height: component.height,
      layoutMode: "layoutMode" in component ? component.layoutMode : null,
      childCount: "children" in component ? component.children.length : 0,
    })),
  };
}

function numberOrMixed(value: number | PluginAPI["mixed"] | undefined): number | string | null {
  if (value === undefined) return null;
  return typeof value === "number" ? value : "mixed";
}

async function nodePayload(node: SceneNode, depth: number): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = {
    id: node.id,
    name: node.name,
    type: node.type,
    codeKey: codeKeyOf(node),
  };

  if ("x" in node) {
    payload.x = node.x;
    payload.y = node.y;
    payload.width = node.width;
    payload.height = node.height;
  }

  if ("layoutMode" in node) {
    const layout = node as LayoutNode;
    payload.layoutMode = layout.layoutMode;
    payload.itemSpacing = layout.itemSpacing;
    payload.paddingTop = layout.paddingTop;
    payload.paddingRight = layout.paddingRight;
    payload.paddingBottom = layout.paddingBottom;
    payload.paddingLeft = layout.paddingLeft;
    payload.cornerRadius = numberOrMixed(layout.cornerRadius);
  }

  if ("fills" in node && node.fills !== figma.mixed) {
    const fills = node.fills as ReadonlyArray<Paint>;
    payload.fills = await Promise.all(
      fills.map(async (paint) => {
        const bound = (paint as SolidPaint).boundVariables?.color;
        const target = bound ? await figma.variables.getVariableByIdAsync(bound.id) : null;
        return {
          type: paint.type,
          color: paint.type === "SOLID" ? paint.color : null,
          opacity: paint.opacity ?? 1,
          boundVariable: bound ? { id: bound.id, name: target?.name ?? null } : null,
        };
      }),
    );
  }

  const boundVariables = node.boundVariables ?? {};
  const resolved: Record<string, { id: string; name: string | null }> = {};
  for (const [field, alias] of Object.entries(boundVariables)) {
    const value = alias as VariableAlias | undefined;
    if (!value || value.type !== "VARIABLE_ALIAS") continue;
    const target = await figma.variables.getVariableByIdAsync(value.id);
    resolved[field] = { id: value.id, name: target?.name ?? null };
  }
  payload.boundVariables = resolved;

  if ("children" in node && depth > 0) {
    const children = node.children as readonly SceneNode[];
    payload.children = await Promise.all(children.slice(0, 50).map((child) => nodePayload(child, depth - 1)));
  }

  return payload;
}

async function getNode(params: Record<string, unknown>): Promise<unknown> {
  const nodeId = String(params.nodeId ?? "").trim();
  if (!nodeId) throw new Error("`nodeId` is required.");

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node ${nodeId} not found in this file.`);

  const requested = Number(params.depth ?? 1);
  const depth = Number.isFinite(requested) ? Math.max(0, Math.min(3, Math.trunc(requested))) : 1;
  return { node: await nodePayload(node as SceneNode, depth) };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "status":
      return {
        file: { name: figma.root.name, key: figma.fileKey ?? "draft" },
        plugin: { name: PLUGIN_NAME, apiVersion: figma.apiVersion },
        collections: (await localCollections()).length,
        variables: (await figma.variables.getLocalVariablesAsync()).length,
      };
    case "list_collections":
      return listCollections();
    case "list_variables":
      return listVariables(params);
    case "create_collection":
      return createCollection(params);
    case "upsert_variables":
      return upsertVariables(params);
    case "rename_variable":
      return renameVariable(params);
    case "delete_variable":
      return deleteVariables(params);
    case "list_components":
      return listComponents(params);
    case "upsert_component":
      return upsertComponent(params);
    case "get_node":
      return getNode(params);
    default:
      throw new Error(`Unknown method "${method}".`);
  }
}

figma.showUI(__html__, { width: 340, height: 300, themeColors: true });

async function announceContext(): Promise<void> {
  figma.ui.postMessage({
    type: "context",
    file: { name: figma.root.name, key: figma.fileKey ?? "draft" },
    settings: await loadSettings(),
    plugin: { name: PLUGIN_NAME, apiVersion: figma.apiVersion },
  });
}

figma.ui.onmessage = async (message: UiMessage) => {
  try {
    if (message.type === "settings") {
      await saveSettings({
        host: String(message.host ?? "").trim() || DEFAULT_HOST,
        token: String(message.token ?? ""),
      });
      figma.ui.postMessage({ type: "saved" });
      return;
    }

    if (message.type === "context") {
      await announceContext();
      return;
    }

    if (message.type === "request") {
      const request = message as unknown as UiRequest;
      try {
        const result = await handle(request.method, request.params ?? {});
        figma.ui.postMessage({ type: "response", id: request.id, ok: true, result });
      } catch (error) {
        // Figma's own message — plan limits included — is relayed unchanged.
        figma.ui.postMessage({
          type: "response",
          id: request.id,
          ok: false,
          error: { message: (error as Error).message, name: (error as Error).name },
        });
      }
    }
  } catch (error) {
    figma.ui.postMessage({ type: "log", level: "error", message: (error as Error).message });
  }
};

void announceContext();