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
const HOST_KEY = "elf-bridge-host";
const SESSION_KEY = "elf-bridge-session";
const NAMESPACE = "elf";
const CODE_KEY = "codeKey";
const ROLE_KEY = "role";
const LABEL_ROLE = "label";
const SLOT_ROLE = "slot";
const FILE_LINK_KEY = "elf-file-key";
const DEFAULT_HOST = "localhost:8765";

interface BridgeState {
  /** `host:port`, or a full http(s)/ws(s) URL (e.g. an ngrok tunnel). */
  host: string;
  /** Long-lived secret issued by the bridge after pairing. */
  session: string;
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

/** A child slot: an instance of another component, referenced by codeKey. */
interface InstanceChildInput {
  type: "instance";
  component: string;
}

/** A stroke: a colour to bind/render, plus an optional width (default 1). */
interface StrokeInput {
  color?: FillInput;
  weight?: number;
}

interface ComponentSpecFields {
  layoutMode?: "HORIZONTAL" | "VERTICAL" | "NONE";
  padding?: PaddingInput;
  gap?: NumberOrRef;
  cornerRadius?: NumberOrRef;
  fill?: FillInput;
  stroke?: StrokeInput;
  size?: { width: number; height: number };
  text?: TextInput;
  children?: InstanceChildInput[];
}

interface ComponentInput extends ComponentSpecFields {
  name: string;
  codeKey?: string;
  parentId?: string;
}

interface ComponentVariantInput {
  /** Variant property values, e.g. `{ size: "sm", intent: "primary" }`. */
  props: Record<string, unknown>;
  /** Per-variant overrides on top of the set-level spec fields. */
  spec?: ComponentSpecFields;
}

interface ComponentSetInput extends ComponentSpecFields {
  name: string;
  codeKey?: string;
  parentId?: string;
  variants: ComponentVariantInput[];
}

type LineHeightInput = number | { percent: number } | "auto";
type LetterSpacingInput = number | { percent: number };

interface TextStyleInput {
  name: string;
  codeKey?: string;
  description?: string;
  fontFamily?: string;
  fontStyle?: string;
  fontSize?: number;
  lineHeight?: LineHeightInput;
  letterSpacing?: LetterSpacingInput;
}

interface EffectInput {
  type: string;
  color?: string;
  offset?: { x?: number; y?: number };
  radius?: number;
  spread?: number;
  visible?: boolean;
}

interface EffectStyleInput {
  name: string;
  codeKey?: string;
  description?: string;
  effects: EffectInput[];
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
// Bridge state — kept in clientStorage, never in the document or the repo.
// The session secret is written only after a successful pairing and removed
// on disconnect, so reopening the file connects without asking for a code.
// ---------------------------------------------------------------------------

async function loadBridgeState(): Promise<BridgeState> {
  const legacy = (await figma.clientStorage.getAsync(SETTINGS_KEY)) as
    | { host?: string; token?: string }
    | undefined;
  const storedHost = (await figma.clientStorage.getAsync(HOST_KEY)) as string | undefined;
  const session = (await figma.clientStorage.getAsync(`${SESSION_KEY}:${currentFile().key}`) ?? await figma.clientStorage.getAsync(SESSION_KEY)) as string | undefined;

  // Drop the old handshake token from storage; pairing replaces it.
  if (legacy?.token) {
    await figma.clientStorage.setAsync(SETTINGS_KEY, { host: legacy.host ?? DEFAULT_HOST });
  }

  return {
    host: (typeof storedHost === "string" ? storedHost : typeof legacy?.host === "string" ? legacy.host : DEFAULT_HOST).trim() || DEFAULT_HOST,
    session: typeof session === "string" ? session : "",
  };
}

async function saveHost(host: string): Promise<void> {
  await figma.clientStorage.setAsync(HOST_KEY, host.trim() || DEFAULT_HOST);
}

async function saveSession(session: string): Promise<void> {
  await figma.clientStorage.setAsync(`${SESSION_KEY}:${currentFile().key}`, session);
  await figma.clientStorage.deleteAsync(SESSION_KEY);
}

async function forgetSession(): Promise<void> {
  await figma.clientStorage.deleteAsync(`${SESSION_KEY}:${currentFile().key}`);
  await figma.clientStorage.deleteAsync(SESSION_KEY);
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

type PreparedStroke = PreparedFill & { weight: number };

async function prepareStroke(stroke: StrokeInput): Promise<PreparedStroke> {
  if (!stroke.color) throw new Error("A stroke needs `color` (hex or rgb) or a COLOR `variable`.");
  const weight = Number(stroke.weight ?? 1);
  if (!Number.isFinite(weight) || weight < 0) throw new Error('"stroke.weight" must be a non-negative number.');
  return { ...(await prepareFill(stroke.color)), weight };
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

/** An empty `text.characters` means "no label" — drop any label left by an earlier run. */
function removeLabel(component: ComponentNode): void {
  const existing =
    component.children.find(
      (child) => child.type === "TEXT" && child.getSharedPluginData(NAMESPACE, ROLE_KEY) === LABEL_ROLE,
    ) ?? component.children.find((child) => child.type === "TEXT");
  existing?.remove();
}
function findComponentSet(parent: ChildrenMixin, name: string, codeKey: string): ComponentSetNode | null {
  if (codeKey) {
    const tagged = findDeep(parent, (node) => node.type === "COMPONENT_SET" && codeKeyOf(node) === codeKey);
    if (tagged) return tagged as ComponentSetNode;
  }
  const direct = parent.children.find((child) => child.type === "COMPONENT_SET" && child.name === name);
  if (direct) return direct as ComponentSetNode;
  return (findDeep(parent, (node) => node.type === "COMPONENT_SET" && node.name === name) as ComponentSetNode) ?? null;
}

/**
 * Document-wide codeKey lookup — how instance children find their source
 * component no matter which page or frame it lives on.
 */
async function findTaggedComponent(codeKey: string): Promise<ComponentNode | ComponentSetNode | null> {
  if (!codeKey) return null;
  for (const page of figma.root.children) {
    // Public plugins use dynamic pages: load a page before traversing it.
    if (typeof page.loadAsync === "function") await page.loadAsync();
    const found = page.findOne((node) => {
      if (node.type !== "COMPONENT" && node.type !== "COMPONENT_SET") return false;
      return codeKeyOf(node) === codeKey;
    });
    if (found) return found as ComponentNode | ComponentSetNode;
  }
  return null;
}

type PaddingField = "paddingTop" | "paddingRight" | "paddingBottom" | "paddingLeft";

const PADDING_FIELDS: readonly PaddingField[] = [
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
];

interface ResolvedSlot {
  source: ComponentNode;
  codeKey: string | null;
}

interface PreparedSpec {
  /** null = leave the component's current layout mode alone. */
  layoutMode: "HORIZONTAL" | "VERTICAL" | "NONE" | null;
  padding: { field: PaddingField; value: PreparedNumber }[];
  gap: PreparedNumber | null;
  radius: PreparedNumber | null;
  fill: PreparedFill | null;
  stroke: PreparedStroke | null;
  size: { width: number; height: number } | null;
  text: TextInput | null;
  /** null = leave existing children alone; otherwise the slot list to sync. */
  slots: ResolvedSlot[] | null;
}

async function resolveSlot(child: InstanceChildInput, index: number): Promise<ResolvedSlot> {
  if (child?.type !== "instance") {
    throw new Error(
      `Child ${index} has unknown type "${String((child as { type?: unknown })?.type)}" — only "instance" is supported.`,
    );
  }
  const wanted = String(child.component ?? "").trim();
  const target = await findTaggedComponent(wanted);
  if (!target) {
    throw new Error(`Child ${index} points at "${wanted}", but no component with that codeKey exists in this file yet.`);
  }
  // Instances come from a single variant; the set's tag lives on the set itself.
  return { source: target.type === "COMPONENT_SET" ? target.defaultVariant : target, codeKey: codeKeyOf(target) };
}

/**
 * Resolves everything that can fail *before* any node is touched, so a
 * rejected call never leaves a half-built — or empty — component behind.
 * A reused component keeps its layout mode when the spec omits one.
 */
async function prepareSpec(input: ComponentSpecFields, currentLayout: string): Promise<PreparedSpec> {
  const effective = input.layoutMode ?? currentLayout;
  if ((input.gap !== undefined || input.padding !== undefined) && effective === "NONE") {
    throw new Error('`gap` and `padding` need auto layout — pass layoutMode "VERTICAL" or "HORIZONTAL".');
  }

  const padding: PreparedSpec["padding"] = [];
  if (input.padding) {
    const sides = ["top", "right", "bottom", "left"] as const;
    for (const [index, side] of sides.entries()) {
      const value = input.padding[side] ?? input.padding.all;
      if (value === undefined) continue;
      padding.push({ field: PADDING_FIELDS[index], value: await prepareNumber(value, PADDING_FIELDS[index]) });
    }
  }

  const gap = input.gap === undefined ? null : await prepareNumber(input.gap, "itemSpacing");
  const radius = input.cornerRadius === undefined ? null : await prepareNumber(input.cornerRadius, "cornerRadius");
  const fill = input.fill ? await prepareFill(input.fill) : null;
  const stroke = input.stroke ? await prepareStroke(input.stroke) : null;

  if (input.text) {
    const family = String(input.text.fontFamily ?? "Inter");
    // Figma refuses font writes until the font is loaded; doing it here keeps
    // the component itself untouched when the family is unavailable.
    await figma.loadFontAsync({ family, style: String(input.text.fontStyle ?? "Regular") });
  }

  let size: PreparedSpec["size"] = null;
  if (input.size) {
    const width = Number(input.size.width);
    const height = Number(input.size.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error("`size` needs finite width and height.");
    size = { width, height };
  }

  const slots = input.children ? await Promise.all(input.children.map((child, index) => resolveSlot(child, index))) : null;

  return { layoutMode: input.layoutMode ?? null, padding, gap, radius, fill, stroke, size, text: input.text ?? null, slots };
}

/** Writes a prepared spec onto a component. Only called after all prep succeeded. */
async function applySpec(
  component: ComponentNode,
  prepared: PreparedSpec,
): Promise<{
  bound: Record<string, { variableId: string; variableName: string }>;
  text: TextNode | null;
  children: { id: string; type: string; codeKey: string | null }[];
}> {
  if (prepared.layoutMode) component.layoutMode = prepared.layoutMode;
  if (component.layoutMode !== "NONE") {
    // Auto-layout hugs its content by default; an explicit `size` (below)
    // pins both axes instead.
    component.primaryAxisSizingMode = "AUTO";
    component.counterAxisSizingMode = "AUTO";
  }

  const bound: Record<string, { variableId: string; variableName: string }> = {};
  const write = (field: PaddingField | "itemSpacing" | "cornerRadius", entry: PreparedNumber): void => {
    const target = component as unknown as LayoutNode;
    target.setBoundVariable(field, entry.variable);
    if (entry.literal !== null) (target as unknown as Record<string, number>)[field] = entry.literal;
    if (entry.variable) bound[field] = { variableId: entry.variable.id, variableName: entry.variable.name };
  };

  for (const entry of prepared.padding) write(entry.field, entry.value);
  if (prepared.gap) write("itemSpacing", prepared.gap);
  if (prepared.radius) write("cornerRadius", prepared.radius);

  if (prepared.fill) {
    component.fills = [prepared.fill.paint];
    if (prepared.fill.variable) {
      bound.fills = { variableId: prepared.fill.variable.id, variableName: prepared.fill.variable.name };
    }
  }

  if (prepared.stroke) {
    component.strokes = [prepared.stroke.paint];
    component.strokeAlign = "INSIDE";
    component.strokeWeight = prepared.stroke.weight;
    if (prepared.stroke.variable) {
      bound.strokes = { variableId: prepared.stroke.variable.id, variableName: prepared.stroke.variable.name };
    }
  }

  if (prepared.size) component.resize(prepared.size.width, prepared.size.height);

  let text: TextNode | null = null;
  if (prepared.text) {
    if (String(prepared.text.characters ?? "") === "") removeLabel(component);
    else text = await upsertLabel(component, prepared.text);
  }

  const children = prepared.slots === null ? [] : syncSlots(component, prepared.slots);

  return { bound, text, children };
}

/**
 * Slot children are replaced wholesale when a spec provides `children`.
 * Rebuilding instances is cheap in Figma and keeps re-runs deterministic —
 * there is no partial-update state to reconcile.
 */
function syncSlots(
  component: ComponentNode,
  slots: ResolvedSlot[],
): { id: string; type: string; codeKey: string | null }[] {
  for (const child of [...component.children]) {
    if (child.getSharedPluginData(NAMESPACE, ROLE_KEY) === SLOT_ROLE) child.remove();
  }

  const created: { id: string; type: string; codeKey: string | null }[] = [];
  for (const slot of slots) {
    const instance = slot.source.createInstance();
    component.appendChild(instance);
    instance.setSharedPluginData(NAMESPACE, ROLE_KEY, SLOT_ROLE);
    created.push({ id: instance.id, type: instance.type, codeKey: slot.codeKey });
  }
  return created;
}

async function upsertComponent(params: Record<string, unknown>): Promise<unknown> {
  const input = params as unknown as ComponentInput;
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("A component name is required.");

  const parent = await resolveParent(input.parentId);
  const codeKey = input.codeKey ? String(input.codeKey) : "";
  const existing = findComponent(parent, name, codeKey);

  const prepared = await prepareSpec(input, existing?.layoutMode ?? "NONE");

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

  const applied = await applySpec(component, prepared);

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
    boundVariables: applied.bound,
    text: applied.text ? { id: applied.text.id, characters: applied.text.characters } : null,
    children: applied.children,
  };
}

function specFields(input: ComponentSpecFields): ComponentSpecFields {
  return {
    layoutMode: input.layoutMode,
    padding: input.padding,
    gap: input.gap,
    cornerRadius: input.cornerRadius,
    fill: input.fill,
    stroke: input.stroke,
    size: input.size,
    text: input.text,
    children: input.children,
  };
}

/**
 * Figma never grid-arranges a component set through the API — left alone,
 * every variant sits at (0, 0), stacked. Lay them out deterministically:
 * the first variant property is the row, the remaining ones the columns.
 */
function arrangeVariants(
  set: ComponentSetNode,
  variants: ComponentVariantInput[],
  labelOf: (props: Record<string, unknown>) => string,
): void {
  const children = set.children.filter((child): child is ComponentNode => child.type === "COMPONENT");
  if (children.length === 0) return;

  const propKeys = Object.keys(variants[0]?.props ?? {});
  if (propKeys.length === 0) return;

  const rowValues: string[] = [];
  for (const variant of variants) {
    const value = String(variant?.props?.[propKeys[0]]);
    if (!rowValues.includes(value)) rowValues.push(value);
  }

  const columnOrder: string[] = [];
  const columnOf = (props: Record<string, unknown>): number => {
    const key = propKeys.slice(1).map((prop) => `${prop}=${String(props[prop])}`).join("|");
    const existing = columnOrder.indexOf(key);
    if (existing >= 0) return existing;
    columnOrder.push(key);
    return columnOrder.length - 1;
  };

  const placements = children.map((child) => {
    const props = variants.find((variant) => labelOf(variant?.props ?? {}) === child.name)?.props ?? {};
    return { child, row: Math.max(0, rowValues.indexOf(String(props[propKeys[0]]))), col: columnOf(props) };
  });

  const columnWidths: number[] = [];
  const rowHeights: number[] = [];
  for (const { child, row, col } of placements) {
    columnWidths[col] = Math.max(columnWidths[col] ?? 0, child.width);
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, child.height);
  }

  const columnX: number[] = [];
  let x = 0;
  for (const width of columnWidths) {
    columnX.push(x);
    x += width + VARIANT_GAP;
  }
  const rowY: number[] = [];
  let y = 0;
  for (const height of rowHeights) {
    rowY.push(y);
    y += height + VARIANT_GAP;
  }

  for (const { child, row, col } of placements) {
    child.x = columnX[col] ?? 0;
    child.y = rowY[row] ?? 0;
  }
}

const VARIANT_GAP = 40;


async function upsertComponentSet(params: Record<string, unknown>): Promise<unknown> {
  const input = params as unknown as ComponentSetInput;
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("A component set name is required.");

  const variants = Array.isArray(input.variants) ? input.variants : [];
  if (variants.length === 0) throw new Error("A component set needs at least one variant.");

  const propKeys = Object.keys(variants[0]?.props ?? {});
  if (propKeys.length === 0) {
    throw new Error('Every variant needs at least one property, e.g. { props: { size: "sm" } }.');
  }
  for (const variant of variants) {
    const keys = Object.keys(variant?.props ?? {});
    if (keys.join("\n") !== propKeys.join("\n")) {
      throw new Error("Every variant must declare the same variant properties, in the same order.");
    }
  }

  const variantLabel = (props: Record<string, unknown>): string =>
    propKeys.map((key) => `${key}=${String(props[key])}`).join(", ");
  const names = variants.map((variant) => variantLabel(variant?.props ?? {}));
  if (new Set(names).size !== names.length) throw new Error("Two variants share the same property values.");

  const parent = await resolveParent(input.parentId);
  const codeKey = input.codeKey ? String(input.codeKey) : "";
  const existing = findComponentSet(parent, name, codeKey);
  const existingVariants = existing
    ? (existing.children.filter((child) => child.type === "COMPONENT") as ComponentNode[])
    : [];

  // A matching roster updates variants in place; a changed roster rebuilds
  // the set (documented: instances of the old set detach).
  const canUpdate =
    existing !== null &&
    existingVariants.length === names.length &&
    names.every((variantName) => existingVariants.some((child) => child.name === variantName));

  const plans: { name: string; spec: PreparedSpec; component: ComponentNode | null }[] = [];
  for (const [index, variant] of variants.entries()) {
    const merged: ComponentSpecFields = { ...specFields(input), ...(variant?.spec ?? {}) };
    const target = canUpdate ? (existingVariants.find((child) => child.name === names[index]) ?? null) : null;
    plans.push({ name: names[index], spec: await prepareSpec(merged, target?.layoutMode ?? "NONE"), component: target });
  }

  let set: ComponentSetNode;
  let created = false;
  if (existing && canUpdate) {
    set = existing;
  } else {
    if (existing) existing.remove();
    const components: ComponentNode[] = [];
    for (const plan of plans) {
      const component = figma.createComponent();
      component.name = plan.name;
      parent.appendChild(component);
      components.push(component);
      plan.component = component;
    }
    set = figma.combineAsVariants(components, parent as unknown as BaseNode & ChildrenMixin);
    set.name = name;
    created = true;
  }

  tagCodeKey(set, codeKey);

  const variantPayloads: { id: string; name: string }[] = [];
  for (const plan of plans) {
    const component = plan.component as ComponentNode;
    if (canUpdate) component.name = plan.name;
    await applySpec(component, plan.spec);
    variantPayloads.push({ id: component.id, name: component.name });
  }

  // A set the designer has switched to auto layout keeps its own arrangement.
  if (set.layoutMode === "NONE") arrangeVariants(set, variants, variantLabel);

  return {
    set: {
      id: set.id,
      name: set.name,
      codeKey: codeKeyOf(set),
      created,
      variantCount: variantPayloads.length,
      variants: variantPayloads,
      parentId: parent.id,
    },
  };
}

function toLineHeight(value: LineHeightInput): LineHeight {
  if (value === "auto") return { unit: "AUTO" };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error('"lineHeight" must be a number, { percent }, or "auto".');
    return { unit: "PIXELS", value };
  }
  return { unit: "PERCENT", value: Number(value.percent) };
}

function toLetterSpacing(value: LetterSpacingInput): LetterSpacing {
  if (typeof value === "number") return { unit: "PIXELS", value };
  return { unit: "PERCENT", value: Number(value.percent) };
}

function toEffect(input: EffectInput, index: number): Effect {
  const type = String(input?.type ?? "").toUpperCase();
  if (type === "LAYER_BLUR" || type === "BACKGROUND_BLUR") {
    return { type, blurType: "NORMAL", radius: Number(input?.radius ?? 0), visible: input?.visible !== false };
  }
  if (type !== "DROP_SHADOW" && type !== "INNER_SHADOW") {
    throw new Error(
      `Effect ${index + 1}: unsupported type "${String(input?.type)}". ` +
        "Use DROP_SHADOW, INNER_SHADOW, LAYER_BLUR or BACKGROUND_BLUR.",
    );
  }
  const color = parseColor(String(input?.color ?? "#00000040"));
  return {
    type,
    visible: input?.visible !== false,
    blendMode: "NORMAL",
    color: { r: color.r, g: color.g, b: color.b, a: color.a ?? 1 },
    offset: { x: Number(input?.offset?.x ?? 0), y: Number(input?.offset?.y ?? 0) },
    radius: Number(input?.radius ?? 0),
    spread: Number(input?.spread ?? 0),
  };
}

async function upsertTextStyle(params: Record<string, unknown>): Promise<unknown> {
  const input = params as unknown as TextStyleInput;
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("A style name is required.");

  const codeKey = input.codeKey ? String(input.codeKey) : "";
  const styles = await figma.getLocalTextStylesAsync();
  const existing =
    (codeKey ? styles.find((style) => codeKeyOf(style) === codeKey) : undefined) ??
    styles.find((style) => style.name === name);

  const currentFont = existing ? existing.fontName : null;
  const family = String(input.fontFamily ?? currentFont?.family ?? "Inter");
  const fontStyle = String(input.fontStyle ?? currentFont?.style ?? "Regular");
  // Load the font before creating anything, so an unavailable family leaves
  // no orphan style behind — Figma throws on the first font write otherwise.
  await figma.loadFontAsync({ family, style: fontStyle });

  const textStyle = existing ?? figma.createTextStyle();
  textStyle.name = name;
  tagCodeKey(textStyle, codeKey);
  if (input.description !== undefined) textStyle.description = String(input.description);
  textStyle.fontName = { family, style: fontStyle };
  if (input.fontSize !== undefined) textStyle.fontSize = Number(input.fontSize);
  if (input.lineHeight !== undefined) textStyle.lineHeight = toLineHeight(input.lineHeight);
  if (input.letterSpacing !== undefined) textStyle.letterSpacing = toLetterSpacing(input.letterSpacing);

  return {
    style: {
      id: textStyle.id,
      name: textStyle.name,
      codeKey: codeKeyOf(textStyle),
      created: !existing,
      fontFamily: family,
      fontStyle,
      fontSize: textStyle.fontSize,
    },
  };
}

async function upsertEffectStyle(params: Record<string, unknown>): Promise<unknown> {
  const input = params as unknown as EffectStyleInput;
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("A style name is required.");

  const effects = (Array.isArray(input.effects) ? input.effects : []).map(toEffect);
  if (effects.length === 0) throw new Error("An effect style needs at least one effect.");

  const codeKey = input.codeKey ? String(input.codeKey) : "";
  const styles = await figma.getLocalEffectStylesAsync();
  const existing =
    (codeKey ? styles.find((style) => codeKeyOf(style) === codeKey) : undefined) ??
    styles.find((style) => style.name === name);

  const effectStyle = existing ?? figma.createEffectStyle();
  effectStyle.name = name;
  tagCodeKey(effectStyle, codeKey);
  if (input.description !== undefined) effectStyle.description = String(input.description);
  effectStyle.effects = effects;

  return {
    style: {
      id: effectStyle.id,
      name: effectStyle.name,
      codeKey: codeKeyOf(effectStyle),
      created: !existing,
      effectCount: effects.length,
    },
  };
}

async function listComponents(params: Record<string, unknown>): Promise<unknown> {
  const parent = await resolveParent(params.parentId);
  const deep = params.deep === true;

  const components: SceneNode[] = [];
  const collect = (node: ChildrenMixin): void => {
    for (const child of node.children) {
      if (child.type === "COMPONENT" || child.type === "COMPONENT_SET") components.push(child);
      if (deep && "children" in child) collect(child as ChildrenMixin);
    }
  };
  collect(parent);

  return {
    parentId: parent.id,
    components: components.map((component) => ({
      id: component.id,
      name: component.name,
      type: component.type,
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

async function paintsPayload(paints: ReadonlyArray<Paint>): Promise<Record<string, unknown>[]> {
  return Promise.all(
    paints.map(async (paint) => {
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

  if (node.type === "TEXT") {
    payload.characters = node.characters;
    payload.fontSize = numberOrMixed(node.fontSize);
    payload.fontName = node.fontName === figma.mixed ? "mixed" : node.fontName;
    payload.lineHeight = node.lineHeight === figma.mixed ? "mixed" : node.lineHeight;
    payload.letterSpacing = node.letterSpacing === figma.mixed ? "mixed" : node.letterSpacing;
  }
  if (node.type === "INSTANCE") payload.mainComponentId = (await node.getMainComponentAsync())?.id ?? null;
  if ("effects" in node) payload.effects = node.effects;
  if ("variantProperties" in node) payload.variantProperties = node.variantProperties;
  if ("fills" in node && node.fills !== figma.mixed) {
    payload.fills = await paintsPayload(node.fills as ReadonlyArray<Paint>);
  }

  if ("strokes" in node) {
    payload.strokes = await paintsPayload(node.strokes);
    if ("strokeWeight" in node) {
      payload.strokeWeight = numberOrMixed((node as { strokeWeight: number | PluginAPI["mixed"] }).strokeWeight);
    }
    if ("strokeAlign" in node) payload.strokeAlign = (node as { strokeAlign: string }).strokeAlign;
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

/** Never substitute a shared placeholder for a document identity. */
function nativeFileKey(): string | undefined {
  try {return figma.fileKey;} catch {return undefined;}
}
function currentFile(): { name: string; key: string; verification?: {nonce: string} } {
  const native = nativeFileKey();
  const key = native || (typeof figma.root.getPluginData === "function" ? figma.root.getPluginData(FILE_LINK_KEY) : "");
  if (typeof key !== "string" || !key.trim() || key === "draft") throw new Error("Copy this file’s Figma link and paste it into Elf Bridge to verify its identity.");
  return {name: figma.root.name, key, ...(!native && uiChannel ? {verification: {nonce: uiChannel}} : {})};
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "show_ui":
      figma.ui.show();
      return { visible: true };
    case "status":
      return {
        file: currentFile(),
        plugin: { name: PLUGIN_NAME, apiVersion: figma.apiVersion },
        collections: (await localCollections()).length,
        variables: (await figma.variables.getLocalVariablesAsync()).length,
      };
    case "list_collections":
      return listCollections();
    case "list_styles": {
      const texts = await figma.getLocalTextStylesAsync();
      const effects = await figma.getLocalEffectStylesAsync();
      return { styles: [
        ...texts.map(style => ({ id: style.id, name: style.name, codeKey: style.getSharedPluginData("elf", "codeKey"), kind: "text", fontName: style.fontName, fontSize: style.fontSize, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing })),
        ...effects.map(style => ({ id: style.id, name: style.name, codeKey: style.getSharedPluginData("elf", "codeKey"), kind: "effect", effects: style.effects })),
      ] };
    }
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
    case "upsert_component_set":
      return upsertComponentSet(params);
    case "upsert_text_style":
      return upsertTextStyle(params);
    case "upsert_effect_style":
      return upsertEffectStyle(params);
    case "get_node":
      return getNode(params);
    default:
      throw new Error(`Unknown method "${method}".`);
  }
}

figma.showUI(__html__, { width: 320, height: 480, themeColors: true });
let uiChannel: string | null = null;
function postUi(message: Record<string, unknown>): void {
  figma.ui.postMessage({ ...message, channel: uiChannel });
}

async function announceContext(channel: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!nativeFileKey() && (!figma.root.getPluginData || !figma.root.getPluginData(FILE_LINK_KEY))) {
      postUi({type: "file-link-required"}); return;
    }
    const file = currentFile();
    if (file.verification) figma.root.setSharedPluginData(NAMESPACE, "fileProof", file.verification.nonce);
    const bridge = await Promise.race([
      loadBridgeState(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Figma’s saved settings did not respond. Try again or reopen the plugin.")), 8000); }),
    ]);
    if (uiChannel !== channel) return;
    postUi({
      type: "context",
      file,
      bridge,
      plugin: { name: PLUGIN_NAME, apiVersion: figma.apiVersion },
    });
  } catch (error) {
    if (uiChannel === channel) postUi({ type: "context-error", message: (error as Error).message });
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

figma.ui.onmessage = async (message: UiMessage) => {
  if (!message || typeof message.channel !== "string" || !/^[a-f0-9]{64}$/.test(message.channel)) return;
  if (message.type === "context") { uiChannel = message.channel; await announceContext(uiChannel); return; }
  if (message.channel !== uiChannel) return;
  try {
    if (message.type === "set-file-link") {
      if (nativeFileKey()) throw new Error("This file already has a native identity.");
      const link = typeof message.url === "string" ? message.url : "";
      const match = /^https:\/\/(?:www\.)?figma\.com\/(?:design|file|board)\/([A-Za-z0-9_-]{8,128})(?:[/?#]|$)/.exec(link);
      if (!match) throw new Error("Paste the Figma link for this open file.");
      figma.root.setPluginData(FILE_LINK_KEY, match[1]);
      await announceContext(uiChannel!); return;
    }
    if (message.type === "hide-ui") {
      figma.ui.hide();
      figma.notify("Elf remains connected while this plugin is running.", { timeout: 10000, button: { text: "Show Elf Bridge", action: () => { figma.ui.show(); return false; } } });
      return;
    }
    if (message.type === "save-host") {
      await saveHost(String(message.host ?? ""));
      postUi({ type: "host-saved" });
      return;
    }

    if (message.type === "save-session") {
      const session = String(message.session ?? "");
      if (!session) throw new Error("Cannot save an empty session.");
      await saveSession(session);
      postUi({ type: "session-saved" });
      return;
    }

    if (message.type === "forget-session") {
      await forgetSession();
      postUi({ type: "session-forgotten" });
      return;
    }

    if (message.type === "request") {
      const request = message as unknown as UiRequest;
      try {
        const result = await handle(request.method, request.params ?? {});
        postUi({ type: "response", id: request.id, ok: true, result });
      } catch (error) {
        // Figma's own message — plan limits included — is relayed unchanged.
        postUi({
          type: "response",
          id: request.id,
          ok: false,
          error: { message: (error as Error).message, name: (error as Error).name },
        });
      }
    }
  } catch (error) {
    postUi({ type: "log", level: "error", message: (error as Error).message });
  }
};
