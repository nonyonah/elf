"use strict";
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
const DEFAULT_HOST = "localhost:8765";
// ---------------------------------------------------------------------------
// Bridge state — kept in clientStorage, never in the document or the repo.
// The session secret is written only after a successful pairing and removed
// on disconnect, so reopening the file connects without asking for a code.
// ---------------------------------------------------------------------------
async function loadBridgeState() {
    const legacy = (await figma.clientStorage.getAsync(SETTINGS_KEY));
    const storedHost = (await figma.clientStorage.getAsync(HOST_KEY));
    const session = (await figma.clientStorage.getAsync(SESSION_KEY));
    // Drop the old handshake token from storage; pairing replaces it.
    if (legacy?.token) {
        await figma.clientStorage.setAsync(SETTINGS_KEY, { host: legacy.host ?? DEFAULT_HOST });
    }
    return {
        host: (storedHost ?? legacy?.host ?? DEFAULT_HOST).trim() || DEFAULT_HOST,
        session: typeof session === "string" ? session : "",
    };
}
async function saveHost(host) {
    await figma.clientStorage.setAsync(HOST_KEY, host.trim() || DEFAULT_HOST);
}
async function saveSession(session) {
    await figma.clientStorage.setAsync(SESSION_KEY, session);
}
async function forgetSession() {
    await figma.clientStorage.deleteAsync(SESSION_KEY);
}
// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------
async function localCollections() {
    return figma.variables.getLocalVariableCollectionsAsync();
}
function collectionPayload(collection) {
    return {
        id: collection.id,
        name: collection.name,
        key: collection.key ?? null,
        defaultModeId: collection.defaultModeId,
        modes: collection.modes.map((mode) => ({ modeId: mode.modeId, name: mode.name })),
        variableCount: collection.variableIds.length,
    };
}
async function findCollection(nameOrId) {
    const collections = await localCollections();
    const found = collections.find((collection) => collection.name === nameOrId || collection.id === nameOrId);
    if (found)
        return found;
    const available = collections.map((collection) => collection.name).join(", ") || "none";
    throw new Error(`Variable collection "${nameOrId}" not found. Available: ${available}.`);
}
function findMode(collection, key) {
    const byName = collection.modes.find((mode) => mode.name === key || mode.modeId === key);
    if (byName)
        return byName;
    const lower = key.toLowerCase();
    return collection.modes.find((mode) => mode.name.toLowerCase() === lower) ?? null;
}
function defaultMode(collection) {
    const mode = collection.modes.find((candidate) => candidate.modeId === collection.defaultModeId);
    if (!mode)
        throw new Error(`Variable collection "${collection.name}" has no modes.`);
    return mode;
}
function codeKeyOf(target) {
    return target.getSharedPluginData(NAMESPACE, CODE_KEY) || null;
}
function tagCodeKey(target, codeKey) {
    if (!codeKey)
        return;
    target.setSharedPluginData(NAMESPACE, CODE_KEY, codeKey);
}
function colorToHex(color) {
    const channel = (value) => Math.round(Math.min(1, Math.max(0, value)) * 255)
        .toString(16)
        .padStart(2, "0");
    const alpha = color.a ?? 1;
    const hex = `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
    return alpha >= 0.995 ? hex : `${hex}${channel(alpha)}`;
}
/** Accepts #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba(). Channels are 0–255. */
function parseColor(input) {
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
function isColorLike(value) {
    if (typeof value !== "string")
        return false;
    return /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value.trim()) || /^rgba?\([^)]+\)$/i.test(value.trim());
}
function isAlias(value) {
    return typeof value === "object" && value !== null && typeof value.variable === "string";
}
function isChannels(value) {
    return (typeof value === "object" &&
        value !== null &&
        typeof value.r === "number" &&
        typeof value.g === "number" &&
        typeof value.b === "number");
}
function inferType(value) {
    if (isAlias(value))
        return null;
    if (isChannels(value))
        return "COLOR";
    if (typeof value === "number")
        return "FLOAT";
    if (typeof value === "boolean")
        return "BOOLEAN";
    if (isColorLike(value))
        return "COLOR";
    if (typeof value === "string")
        return "STRING";
    return null;
}
async function resolveVariable(nameOrId) {
    const variables = await figma.variables.getLocalVariablesAsync();
    if (nameOrId.includes(":")) {
        const byId = variables.find((variable) => variable.id === nameOrId);
        if (byId)
            return byId;
    }
    const slash = nameOrId.indexOf("/");
    if (slash > 0) {
        const collectionName = nameOrId.slice(0, slash);
        const variableName = nameOrId.slice(slash + 1);
        const collection = (await localCollections()).find((candidate) => candidate.name === collectionName);
        const scoped = collection
            ? variables.find((variable) => variable.name === variableName && variable.variableCollectionId === collection.id)
            : undefined;
        if (scoped)
            return scoped;
    }
    const exact = variables.filter((variable) => variable.name === nameOrId);
    if (exact.length === 1)
        return exact[0];
    if (exact.length > 1) {
        const names = exact.map((variable) => variable.name).join(", ");
        throw new Error(`Variable "${nameOrId}" is ambiguous (${names}). Use "collection/name" or the variable id.`);
    }
    throw new Error(`Variable "${nameOrId}" not found in this file.`);
}
async function toFigmaValue(type, value) {
    if (isAlias(value)) {
        const target = await resolveVariable(value.variable);
        if (target.resolvedType !== type) {
            throw new Error(`Variable "${value.variable}" is ${target.resolvedType}, but this variable is ${type}.`);
        }
        return figma.variables.createVariableAlias(target);
    }
    if (type === "COLOR") {
        if (isChannels(value))
            return value;
        if (typeof value === "string")
            return parseColor(value);
        throw new Error(`Expected a colour, got ${typeof value}.`);
    }
    if (type === "FLOAT") {
        const numeric = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(numeric))
            throw new Error(`Expected a number for a FLOAT variable, got "${String(value)}".`);
        return numeric;
    }
    if (type === "BOOLEAN") {
        if (typeof value !== "boolean")
            throw new Error(`Expected true/false for a BOOLEAN variable, got "${String(value)}".`);
        return value;
    }
    return String(value);
}
function isAliasValue(value) {
    return typeof value === "object" && value !== null && value.type === "VARIABLE_ALIAS";
}
async function variablePayload(variable) {
    const collections = await localCollections();
    const collection = collections.find((candidate) => candidate.id === variable.variableCollectionId);
    const valuesByMode = {};
    for (const mode of collection?.modes ?? []) {
        const entry = variable.valuesByMode[mode.modeId];
        if (entry === undefined)
            continue;
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
async function listCollections() {
    const collections = await localCollections();
    return { collections: collections.map(collectionPayload) };
}
async function listVariables(params) {
    const collection = params.collection ? await findCollection(String(params.collection)) : null;
    const type = params.type ? String(params.type) : undefined;
    const variables = await figma.variables.getLocalVariablesAsync(type);
    const scoped = collection
        ? variables.filter((variable) => variable.variableCollectionId === collection.id)
        : variables;
    return { variables: await Promise.all(scoped.map((variable) => variablePayload(variable))) };
}
async function createCollection(params) {
    const name = String(params.name ?? "").trim();
    if (!name)
        throw new Error("A collection name is required.");
    const existing = (await localCollections()).find((collection) => collection.name === name);
    if (existing) {
        for (const mode of params.modes ?? [])
            addMissingMode(existing, mode);
        return { collection: collectionPayload(existing), created: false };
    }
    const collection = figma.variables.createVariableCollection(name);
    // A new collection ships with one default mode; rename it to the first name
    // the caller asked for so the result is exactly the mode list they gave.
    let first = true;
    for (const mode of params.modes ?? []) {
        if (first) {
            const target = defaultMode(collection);
            if (target.name !== mode)
                collection.renameMode(target.modeId, mode);
            first = false;
            continue;
        }
        addMissingMode(collection, mode);
    }
    return { collection: collectionPayload(collection), created: true };
}
function addMissingMode(collection, modeName) {
    if (!modeName)
        return;
    if (findMode(collection, modeName))
        return;
    // Plan limits surface here as Figma's own error, relayed untouched.
    collection.addMode(modeName);
}
async function upsertVariables(params) {
    const collection = await findCollection(String(params.collection ?? ""));
    const specs = params.variables ?? [];
    const fallbackKey = params.defaultMode ? String(params.defaultMode) : null;
    if (fallbackKey && !findMode(collection, fallbackKey)) {
        throw new Error(`Unknown mode "${fallbackKey}" in collection "${collection.name}". ` +
            `Modes: ${collection.modes.map((mode) => mode.name).join(", ")}.`);
    }
    const byName = new Map();
    for (const variable of await figma.variables.getLocalVariablesAsync()) {
        if (variable.variableCollectionId === collection.id)
            byName.set(variable.name, variable);
    }
    const results = [];
    const errors = [];
    for (const spec of specs) {
        const name = String(spec?.name ?? "").trim();
        try {
            if (!name)
                throw new Error("A variable name is required.");
            const values = spec.values ?? {};
            const firstValue = Object.values(values)[0];
            if (firstValue === undefined)
                throw new Error(`Variable "${name}" has no values.`);
            const type = spec.type ?? inferType(firstValue) ?? (await aliasType(firstValue));
            const existing = byName.get(name);
            if (existing && existing.resolvedType !== type) {
                throw new Error(`Variable "${name}" already exists with type ${existing.resolvedType}; Figma types cannot change.`);
            }
            // Resolve modes and convert every value before touching Figma: a
            // rejected item must not leave a half-written variable behind.
            const fallback = spec.mode
                ? findMode(collection, spec.mode)
                : fallbackKey
                    ? findMode(collection, fallbackKey)
                    : defaultMode(collection);
            if (spec.mode && !fallback) {
                throw new Error(`Unknown mode "${spec.mode}" in collection "${collection.name}". ` +
                    `Modes: ${collection.modes.map((mode) => mode.name).join(", ")}.`);
            }
            const prepared = [];
            for (const [key, value] of Object.entries(values)) {
                const mode = findMode(collection, key) ?? fallback;
                if (!mode)
                    throw new Error(`No mode to write "${key}" for variable "${name}".`);
                prepared.push({ modeId: mode.modeId, value: await toFigmaValue(type, value) });
            }
            const variable = existing ?? figma.variables.createVariable(name, collection, type);
            if (!existing)
                byName.set(name, variable);
            if (spec.description !== undefined)
                variable.description = String(spec.description);
            if (spec.scopes)
                variable.scopes = spec.scopes;
            tagCodeKey(variable, String(spec.codeKey ?? ""));
            for (const entry of prepared)
                variable.setValueForMode(entry.modeId, entry.value);
            results.push({
                id: variable.id,
                name: variable.name,
                action: existing ? "updated" : "created",
                resolvedType: variable.resolvedType,
                codeKey: codeKeyOf(variable),
                codeKeySet: codeKeyOf(variable) !== null,
            });
        }
        catch (error) {
            errors.push({ name, message: error.message });
        }
    }
    return { collection: collectionPayload(collection), variables: results, errors };
}
async function aliasType(value) {
    if (!isAlias(value))
        throw new Error(`Cannot infer a type for ${JSON.stringify(value)} — pass "type".`);
    return (await resolveVariable(value.variable)).resolvedType;
}
async function renameVariable(params) {
    const newName = String(params.newName ?? "").trim();
    if (!newName)
        throw new Error("A new name is required.");
    let collection = params.collection
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
    if (clash)
        throw new Error(`"${newName}" already exists in collection "${collection?.name}".`);
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
async function deleteVariables(params) {
    const collection = params.collection ? await findCollection(String(params.collection)) : null;
    const all = await figma.variables.getLocalVariablesAsync();
    const inScope = (variable) => !collection || variable.variableCollectionId === collection.id;
    const deleted = [];
    const missing = [];
    const remove = (variable, label) => {
        if (!variable) {
            missing.push(label);
            return;
        }
        const name = variable.name;
        variable.remove();
        deleted.push({ id: variable.id, name });
    };
    for (const id of params.ids ?? []) {
        remove(all.find((variable) => variable.id === id && inScope(variable)), String(id));
    }
    for (const name of params.names ?? []) {
        remove(all.find((variable) => variable.name === name && inScope(variable) && !deleted.some((entry) => entry.name === name)), String(name));
    }
    return { deleted, missing };
}
async function resolveParent(parentId) {
    if (parentId) {
        const node = await figma.getNodeByIdAsync(String(parentId));
        if (!node)
            throw new Error(`Parent node ${String(parentId)} not found in this file.`);
        if (!("appendChild" in node)) {
            throw new Error(`Node ${node.id} (${node.type}) cannot contain children.`);
        }
        return node;
    }
    return figma.currentPage;
}
function eachChild(parent, visit) {
    for (const child of parent.children) {
        if (visit(child))
            return true;
    }
    return false;
}
function findDeep(parent, predicate) {
    if (eachChild(parent, predicate)) {
        const match = parent.children.find((child) => predicate(child));
        return match ?? null;
    }
    for (const child of parent.children) {
        if (!("children" in child))
            continue;
        const found = findDeep(child, predicate);
        if (found)
            return found;
    }
    return null;
}
/** Upsert key: the codeKey tag wins, then the component name. */
function findComponent(parent, name, codeKey) {
    if (codeKey) {
        const tagged = findDeep(parent, (node) => node.type === "COMPONENT" && codeKeyOf(node) === codeKey);
        if (tagged)
            return tagged;
    }
    const direct = parent.children.find((child) => child.type === "COMPONENT" && child.name === name);
    if (direct)
        return direct;
    return findDeep(parent, (node) => node.type === "COMPONENT" && node.name === name) ?? null;
}
async function requireFloatVariable(nameOrId, field) {
    const variable = await resolveVariable(nameOrId);
    if (variable.resolvedType !== "FLOAT") {
        throw new Error(`Variable "${nameOrId}" is ${variable.resolvedType}, but "${field}" needs a FLOAT variable.`);
    }
    return variable;
}
async function prepareNumber(value, field) {
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw new Error(`"${field}" must be a finite number.`);
        return { literal: value, variable: null };
    }
    return { literal: null, variable: await requireFloatVariable(String(value.variable), field) };
}
async function prepareFill(fill) {
    if (fill.variable) {
        const variable = await resolveVariable(String(fill.variable));
        if (variable.resolvedType !== "COLOR") {
            throw new Error(`Variable "${fill.variable}" is ${variable.resolvedType}, but a fill needs a COLOR variable.`);
        }
        // Keep a literal colour under the binding so the node still renders.
        const fallback = { type: "SOLID", color: parseColor(String(fill.color ?? "#000000")) };
        return { paint: figma.variables.setBoundVariableForPaint(fallback, "color", variable), variable };
    }
    if (!fill.color)
        throw new Error("A fill needs either `color` (hex or rgb) or `variable`.");
    const opacity = fill.opacity === undefined ? undefined : Number(fill.opacity);
    return {
        paint: { type: "SOLID", color: parseColor(String(fill.color)), ...(opacity === undefined ? {} : { opacity }) },
        variable: null,
    };
}
async function applyFill(target, fill) {
    const prepared = await prepareFill(fill);
    target.fills = [prepared.paint];
    return prepared.variable ? { variableId: prepared.variable.id, variableName: prepared.variable.name } : null;
}
async function prepareStroke(stroke) {
    if (!stroke.color)
        throw new Error("A stroke needs `color` (hex or rgb) or a COLOR `variable`.");
    const weight = Number(stroke.weight ?? 1);
    if (!Number.isFinite(weight) || weight < 0)
        throw new Error('"stroke.weight" must be a non-negative number.');
    return { ...(await prepareFill(stroke.color)), weight };
}
async function upsertLabel(component, text) {
    const family = String(text.fontFamily ?? "Inter");
    const style = String(text.fontStyle ?? "Regular");
    // Figma refuses font changes until the font is loaded.
    await figma.loadFontAsync({ family, style });
    const existing = component.children.find((child) => child.type === "TEXT" && child.getSharedPluginData(NAMESPACE, ROLE_KEY) === LABEL_ROLE) ?? component.children.find((child) => child.type === "TEXT");
    const label = existing ?? figma.createText();
    if (!existing) {
        component.appendChild(label);
        label.setSharedPluginData(NAMESPACE, ROLE_KEY, LABEL_ROLE);
    }
    label.fontName = { family, style };
    label.characters = String(text.characters ?? "");
    if (text.fontSize !== undefined)
        label.fontSize = Number(text.fontSize);
    if (text.color)
        await applyFill(label, text.color);
    return label;
}
/** An empty `text.characters` means "no label" — drop any label left by an earlier run. */
function removeLabel(component) {
    const existing = component.children.find((child) => child.type === "TEXT" && child.getSharedPluginData(NAMESPACE, ROLE_KEY) === LABEL_ROLE) ?? component.children.find((child) => child.type === "TEXT");
    existing?.remove();
}
function findComponentSet(parent, name, codeKey) {
    if (codeKey) {
        const tagged = findDeep(parent, (node) => node.type === "COMPONENT_SET" && codeKeyOf(node) === codeKey);
        if (tagged)
            return tagged;
    }
    const direct = parent.children.find((child) => child.type === "COMPONENT_SET" && child.name === name);
    if (direct)
        return direct;
    return findDeep(parent, (node) => node.type === "COMPONENT_SET" && node.name === name) ?? null;
}
/**
 * Document-wide codeKey lookup — how instance children find their source
 * component no matter which page or frame it lives on.
 */
function findTaggedComponent(codeKey) {
    if (!codeKey)
        return null;
    for (const page of figma.root.children) {
        const found = page.findOne((node) => {
            if (node.type !== "COMPONENT" && node.type !== "COMPONENT_SET")
                return false;
            return codeKeyOf(node) === codeKey;
        });
        if (found)
            return found;
    }
    return null;
}
const PADDING_FIELDS = [
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
];
function resolveSlot(child, index) {
    if (child?.type !== "instance") {
        throw new Error(`Child ${index} has unknown type "${String(child?.type)}" — only "instance" is supported.`);
    }
    const wanted = String(child.component ?? "").trim();
    const target = findTaggedComponent(wanted);
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
async function prepareSpec(input, currentLayout) {
    const effective = input.layoutMode ?? currentLayout;
    if ((input.gap !== undefined || input.padding !== undefined) && effective === "NONE") {
        throw new Error('`gap` and `padding` need auto layout — pass layoutMode "VERTICAL" or "HORIZONTAL".');
    }
    const padding = [];
    if (input.padding) {
        const sides = ["top", "right", "bottom", "left"];
        for (const [index, side] of sides.entries()) {
            const value = input.padding[side] ?? input.padding.all;
            if (value === undefined)
                continue;
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
    let size = null;
    if (input.size) {
        const width = Number(input.size.width);
        const height = Number(input.size.height);
        if (!Number.isFinite(width) || !Number.isFinite(height))
            throw new Error("`size` needs finite width and height.");
        size = { width, height };
    }
    const slots = input.children ? input.children.map((child, index) => resolveSlot(child, index)) : null;
    return { layoutMode: input.layoutMode ?? null, padding, gap, radius, fill, stroke, size, text: input.text ?? null, slots };
}
/** Writes a prepared spec onto a component. Only called after all prep succeeded. */
async function applySpec(component, prepared) {
    if (prepared.layoutMode)
        component.layoutMode = prepared.layoutMode;
    if (component.layoutMode !== "NONE") {
        // Auto-layout hugs its content by default; an explicit `size` (below)
        // pins both axes instead.
        component.primaryAxisSizingMode = "AUTO";
        component.counterAxisSizingMode = "AUTO";
    }
    const bound = {};
    const write = (field, entry) => {
        const target = component;
        target.setBoundVariable(field, entry.variable);
        if (entry.literal !== null)
            target[field] = entry.literal;
        if (entry.variable)
            bound[field] = { variableId: entry.variable.id, variableName: entry.variable.name };
    };
    for (const entry of prepared.padding)
        write(entry.field, entry.value);
    if (prepared.gap)
        write("itemSpacing", prepared.gap);
    if (prepared.radius)
        write("cornerRadius", prepared.radius);
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
    if (prepared.size)
        component.resize(prepared.size.width, prepared.size.height);
    let text = null;
    if (prepared.text) {
        if (String(prepared.text.characters ?? "") === "")
            removeLabel(component);
        else
            text = await upsertLabel(component, prepared.text);
    }
    const children = prepared.slots === null ? [] : syncSlots(component, prepared.slots);
    return { bound, text, children };
}
/**
 * Slot children are replaced wholesale when a spec provides `children`.
 * Rebuilding instances is cheap in Figma and keeps re-runs deterministic —
 * there is no partial-update state to reconcile.
 */
function syncSlots(component, slots) {
    for (const child of [...component.children]) {
        if (child.getSharedPluginData(NAMESPACE, ROLE_KEY) === SLOT_ROLE)
            child.remove();
    }
    const created = [];
    for (const slot of slots) {
        const instance = slot.source.createInstance();
        component.appendChild(instance);
        instance.setSharedPluginData(NAMESPACE, ROLE_KEY, SLOT_ROLE);
        created.push({ id: instance.id, type: instance.type, codeKey: slot.codeKey });
    }
    return created;
}
async function upsertComponent(params) {
    const input = params;
    const name = String(input.name ?? "").trim();
    if (!name)
        throw new Error("A component name is required.");
    const parent = await resolveParent(input.parentId);
    const codeKey = input.codeKey ? String(input.codeKey) : "";
    const existing = findComponent(parent, name, codeKey);
    const prepared = await prepareSpec(input, existing?.layoutMode ?? "NONE");
    let component;
    let created = false;
    if (existing) {
        component = existing;
    }
    else {
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
function specFields(input) {
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
function arrangeVariants(set, variants, labelOf) {
    const children = set.children.filter((child) => child.type === "COMPONENT");
    if (children.length === 0)
        return;
    const propKeys = Object.keys(variants[0]?.props ?? {});
    if (propKeys.length === 0)
        return;
    const rowValues = [];
    for (const variant of variants) {
        const value = String(variant?.props?.[propKeys[0]]);
        if (!rowValues.includes(value))
            rowValues.push(value);
    }
    const columnOrder = [];
    const columnOf = (props) => {
        const key = propKeys.slice(1).map((prop) => `${prop}=${String(props[prop])}`).join("|");
        const existing = columnOrder.indexOf(key);
        if (existing >= 0)
            return existing;
        columnOrder.push(key);
        return columnOrder.length - 1;
    };
    const placements = children.map((child) => {
        const props = variants.find((variant) => labelOf(variant?.props ?? {}) === child.name)?.props ?? {};
        return { child, row: Math.max(0, rowValues.indexOf(String(props[propKeys[0]]))), col: columnOf(props) };
    });
    const columnWidths = [];
    const rowHeights = [];
    for (const { child, row, col } of placements) {
        columnWidths[col] = Math.max(columnWidths[col] ?? 0, child.width);
        rowHeights[row] = Math.max(rowHeights[row] ?? 0, child.height);
    }
    const columnX = [];
    let x = 0;
    for (const width of columnWidths) {
        columnX.push(x);
        x += width + VARIANT_GAP;
    }
    const rowY = [];
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
async function upsertComponentSet(params) {
    const input = params;
    const name = String(input.name ?? "").trim();
    if (!name)
        throw new Error("A component set name is required.");
    const variants = Array.isArray(input.variants) ? input.variants : [];
    if (variants.length === 0)
        throw new Error("A component set needs at least one variant.");
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
    const variantLabel = (props) => propKeys.map((key) => `${key}=${String(props[key])}`).join(", ");
    const names = variants.map((variant) => variantLabel(variant?.props ?? {}));
    if (new Set(names).size !== names.length)
        throw new Error("Two variants share the same property values.");
    const parent = await resolveParent(input.parentId);
    const codeKey = input.codeKey ? String(input.codeKey) : "";
    const existing = findComponentSet(parent, name, codeKey);
    const existingVariants = existing
        ? existing.children.filter((child) => child.type === "COMPONENT")
        : [];
    // A matching roster updates variants in place; a changed roster rebuilds
    // the set (documented: instances of the old set detach).
    const canUpdate = existing !== null &&
        existingVariants.length === names.length &&
        names.every((variantName) => existingVariants.some((child) => child.name === variantName));
    const plans = [];
    for (const [index, variant] of variants.entries()) {
        const merged = { ...specFields(input), ...(variant?.spec ?? {}) };
        const target = canUpdate ? (existingVariants.find((child) => child.name === names[index]) ?? null) : null;
        plans.push({ name: names[index], spec: await prepareSpec(merged, target?.layoutMode ?? "NONE"), component: target });
    }
    let set;
    let created = false;
    if (existing && canUpdate) {
        set = existing;
    }
    else {
        if (existing)
            existing.remove();
        const components = [];
        for (const plan of plans) {
            const component = figma.createComponent();
            component.name = plan.name;
            parent.appendChild(component);
            components.push(component);
            plan.component = component;
        }
        set = figma.combineAsVariants(components, parent);
        set.name = name;
        created = true;
    }
    tagCodeKey(set, codeKey);
    const variantPayloads = [];
    for (const plan of plans) {
        const component = plan.component;
        if (canUpdate)
            component.name = plan.name;
        await applySpec(component, plan.spec);
        variantPayloads.push({ id: component.id, name: component.name });
    }
    // A set the designer has switched to auto layout keeps its own arrangement.
    if (set.layoutMode === "NONE")
        arrangeVariants(set, variants, variantLabel);
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
function toLineHeight(value) {
    if (value === "auto")
        return { unit: "AUTO" };
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw new Error('"lineHeight" must be a number, { percent }, or "auto".');
        return { unit: "PIXELS", value };
    }
    return { unit: "PERCENT", value: Number(value.percent) };
}
function toLetterSpacing(value) {
    if (typeof value === "number")
        return { unit: "PIXELS", value };
    return { unit: "PERCENT", value: Number(value.percent) };
}
function toEffect(input, index) {
    const type = String(input?.type ?? "").toUpperCase();
    if (type === "LAYER_BLUR" || type === "BACKGROUND_BLUR") {
        return { type, blurType: "NORMAL", radius: Number(input?.radius ?? 0), visible: input?.visible !== false };
    }
    if (type !== "DROP_SHADOW" && type !== "INNER_SHADOW") {
        throw new Error(`Effect ${index + 1}: unsupported type "${String(input?.type)}". ` +
            "Use DROP_SHADOW, INNER_SHADOW, LAYER_BLUR or BACKGROUND_BLUR.");
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
async function upsertTextStyle(params) {
    const input = params;
    const name = String(input.name ?? "").trim();
    if (!name)
        throw new Error("A style name is required.");
    const codeKey = input.codeKey ? String(input.codeKey) : "";
    const styles = await figma.getLocalTextStylesAsync();
    const existing = (codeKey ? styles.find((style) => codeKeyOf(style) === codeKey) : undefined) ??
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
    if (input.description !== undefined)
        textStyle.description = String(input.description);
    textStyle.fontName = { family, style: fontStyle };
    if (input.fontSize !== undefined)
        textStyle.fontSize = Number(input.fontSize);
    if (input.lineHeight !== undefined)
        textStyle.lineHeight = toLineHeight(input.lineHeight);
    if (input.letterSpacing !== undefined)
        textStyle.letterSpacing = toLetterSpacing(input.letterSpacing);
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
async function upsertEffectStyle(params) {
    const input = params;
    const name = String(input.name ?? "").trim();
    if (!name)
        throw new Error("A style name is required.");
    const effects = (Array.isArray(input.effects) ? input.effects : []).map(toEffect);
    if (effects.length === 0)
        throw new Error("An effect style needs at least one effect.");
    const codeKey = input.codeKey ? String(input.codeKey) : "";
    const styles = await figma.getLocalEffectStylesAsync();
    const existing = (codeKey ? styles.find((style) => codeKeyOf(style) === codeKey) : undefined) ??
        styles.find((style) => style.name === name);
    const effectStyle = existing ?? figma.createEffectStyle();
    effectStyle.name = name;
    tagCodeKey(effectStyle, codeKey);
    if (input.description !== undefined)
        effectStyle.description = String(input.description);
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
async function listComponents(params) {
    const parent = await resolveParent(params.parentId);
    const deep = params.deep === true;
    const components = [];
    const collect = (node) => {
        for (const child of node.children) {
            if (child.type === "COMPONENT")
                components.push(child);
            if (deep && "children" in child)
                collect(child);
        }
    };
    collect(parent);
    return {
        parentId: parent.id,
        components: components.map((component) => ({
            id: component.id,
            name: component.name,
            codeKey: codeKeyOf(component),
            parentId: component.parent ? component.parent.id : null,
            width: component.width,
            height: component.height,
            layoutMode: "layoutMode" in component ? component.layoutMode : null,
            childCount: "children" in component ? component.children.length : 0,
        })),
    };
}
function numberOrMixed(value) {
    if (value === undefined)
        return null;
    return typeof value === "number" ? value : "mixed";
}
async function paintsPayload(paints) {
    return Promise.all(paints.map(async (paint) => {
        const bound = paint.boundVariables?.color;
        const target = bound ? await figma.variables.getVariableByIdAsync(bound.id) : null;
        return {
            type: paint.type,
            color: paint.type === "SOLID" ? paint.color : null,
            opacity: paint.opacity ?? 1,
            boundVariable: bound ? { id: bound.id, name: target?.name ?? null } : null,
        };
    }));
}
async function nodePayload(node, depth) {
    const payload = {
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
        const layout = node;
        payload.layoutMode = layout.layoutMode;
        payload.itemSpacing = layout.itemSpacing;
        payload.paddingTop = layout.paddingTop;
        payload.paddingRight = layout.paddingRight;
        payload.paddingBottom = layout.paddingBottom;
        payload.paddingLeft = layout.paddingLeft;
        payload.cornerRadius = numberOrMixed(layout.cornerRadius);
    }
    if ("fills" in node && node.fills !== figma.mixed) {
        payload.fills = await paintsPayload(node.fills);
    }
    if ("strokes" in node) {
        payload.strokes = await paintsPayload(node.strokes);
        if ("strokeWeight" in node) {
            payload.strokeWeight = numberOrMixed(node.strokeWeight);
        }
        if ("strokeAlign" in node)
            payload.strokeAlign = node.strokeAlign;
    }
    const boundVariables = node.boundVariables ?? {};
    const resolved = {};
    for (const [field, alias] of Object.entries(boundVariables)) {
        const value = alias;
        if (!value || value.type !== "VARIABLE_ALIAS")
            continue;
        const target = await figma.variables.getVariableByIdAsync(value.id);
        resolved[field] = { id: value.id, name: target?.name ?? null };
    }
    payload.boundVariables = resolved;
    if ("children" in node && depth > 0) {
        const children = node.children;
        payload.children = await Promise.all(children.slice(0, 50).map((child) => nodePayload(child, depth - 1)));
    }
    return payload;
}
async function getNode(params) {
    const nodeId = String(params.nodeId ?? "").trim();
    if (!nodeId)
        throw new Error("`nodeId` is required.");
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node)
        throw new Error(`Node ${nodeId} not found in this file.`);
    const requested = Number(params.depth ?? 1);
    const depth = Number.isFinite(requested) ? Math.max(0, Math.min(3, Math.trunc(requested))) : 1;
    return { node: await nodePayload(node, depth) };
}
// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
async function handle(method, params) {
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
async function announceContext() {
    figma.ui.postMessage({
        type: "context",
        file: { name: figma.root.name, key: figma.fileKey ?? "draft" },
        bridge: await loadBridgeState(),
        plugin: { name: PLUGIN_NAME, apiVersion: figma.apiVersion },
    });
}
figma.ui.onmessage = async (message) => {
    try {
        if (message.type === "save-host") {
            await saveHost(String(message.host ?? ""));
            figma.ui.postMessage({ type: "host-saved" });
            return;
        }
        if (message.type === "save-session") {
            const session = String(message.session ?? "");
            if (!session)
                throw new Error("Cannot save an empty session.");
            await saveSession(session);
            figma.ui.postMessage({ type: "session-saved" });
            return;
        }
        if (message.type === "forget-session") {
            await forgetSession();
            figma.ui.postMessage({ type: "session-forgotten" });
            return;
        }
        if (message.type === "context") {
            await announceContext();
            return;
        }
        if (message.type === "request") {
            const request = message;
            try {
                const result = await handle(request.method, request.params ?? {});
                figma.ui.postMessage({ type: "response", id: request.id, ok: true, result });
            }
            catch (error) {
                // Figma's own message — plan limits included — is relayed unchanged.
                figma.ui.postMessage({
                    type: "response",
                    id: request.id,
                    ok: false,
                    error: { message: error.message, name: error.name },
                });
            }
        }
    }
    catch (error) {
        figma.ui.postMessage({ type: "log", level: "error", message: error.message });
    }
};
void announceContext();
