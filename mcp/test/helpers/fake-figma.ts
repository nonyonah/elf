import type { MethodHandler } from "./plugin-connection.js";

export interface FakeVariable {
  id: string;
  name: string;
  resolvedType: string;
  description: string;
  scopes: string[];
  codeKey: string | null;
  valuesByMode: Record<string, { type: string; value: unknown }>;
}

export interface FakeCollection {
  id: string;
  name: string;
  key: string;
  defaultModeId: string;
  modes: { modeId: string; name: string }[];
  variables: FakeVariable[];
}

export interface FakeFigma {
  handlers: Record<string, MethodHandler>;
  collections: FakeCollection[];
  nextId: () => string;
}

/**
 * A stand-in for the Figma Plugin API's variable side, complete with the rules
 * the real API enforces (upsert by name, immutable types, mode names/ids).
 * It only needs to be faithful enough to prove the MCP tools behave.
 */
export function createFakeFigma(): FakeFigma {
  let counter = 0;
  const nextId = (): string => `VariableID:fake:${++counter}`;
  const collections: FakeCollection[] = [];

  const collectionPayload = (collection: FakeCollection) => ({
    id: collection.id,
    name: collection.name,
    key: collection.key,
    defaultModeId: collection.defaultModeId,
    modes: collection.modes,
    variableCount: collection.variables.length,
  });

  const findCollection = (nameOrId: string): FakeCollection => {
    const found = collections.find((c) => c.name === nameOrId || c.id === nameOrId);
    if (!found) {
      throw new Error(
        `Variable collection "${nameOrId}" not found. Available: ${collections.map((c) => c.name).join(", ") || "none"}.`,
      );
    }
    return found;
  };

  const findMode = (collection: FakeCollection, key: string) =>
    collection.modes.find((mode) => mode.name === key || mode.modeId === key);

  const handlers: Record<string, MethodHandler> = {
    status: () => ({
      file: { name: "Throwaway File", key: "fakefilekey" },
      collections: collections.length,
    }),

    list_collections: () => ({ collections: collections.map(collectionPayload) }),

    list_variables: (params) => {
      const source = params.collection ? [findCollection(String(params.collection))] : collections;
      const variables = source
        .flatMap((collection) => collection.variables.map((variable) => ({ collection, variable })))
        .filter(({ variable }) => !params.type || variable.resolvedType === params.type)
        .map(({ collection, variable }) => ({
          id: variable.id,
          name: variable.name,
          key: null,
          collectionId: collection.id,
          collectionName: collection.name,
          resolvedType: variable.resolvedType,
          description: variable.description,
          scopes: variable.scopes,
          codeKey: variable.codeKey,
          valuesByMode: variable.valuesByMode,
        }));
      return { variables };
    },

    create_collection: (params) => {
      const name = String(params.name ?? "");
      let collection = collections.find((c) => c.name === name);
      if (!collection) {
        collection = {
          id: `VariableCollectionId:fake:${++counter}`,
          name,
          key: `fakekey-${counter}`,
          defaultModeId: "mode-1",
          modes: [{ modeId: "mode-1", name: "Mode 1" }],
          variables: [],
        };
        collections.push(collection);
      }
      // A new collection starts with a single default mode; rename it to the
      // first requested name so `modes` describes the collection exactly.
      for (const [index, mode] of ((params.modes as string[] | undefined) ?? []).entries()) {
        if (findMode(collection, mode)) continue;
        if (index === 0 && collection.modes.length === 1) {
          collection.modes[0] = { ...collection.modes[0], name: mode };
          continue;
        }
        collection.modes.push({ modeId: `mode-${++counter}`, name: mode });
      }
      return { collection: collectionPayload(collection) };
    },

    upsert_variables: (params) => {
      const collection = findCollection(String(params.collection ?? ""));
      const fallback = params.defaultMode ? findMode(collection, String(params.defaultMode)) : collection.modes[0];
      const results: unknown[] = [];
      const errors: { name: string; message: string }[] = [];

      for (const spec of params.variables as Record<string, unknown>[]) {
        const name = String(spec.name ?? "");
        try {
          const values = spec.values as Record<string, unknown>;
          const type = (spec.type as string | undefined) ?? inferType(Object.values(values)[0]);
          if (!type) throw new Error("Cannot infer a type: pass `type` explicitly.");

          let variable = collection.variables.find((candidate) => candidate.name === name);
          const action = variable ? "updated" : "created";
          if (variable && variable.resolvedType !== type) {
            throw new Error(
              `Variable "${name}" already exists with type ${variable.resolvedType}; Figma types cannot change.`,
            );
          }
          if (!variable) {
            variable = {
              id: nextId(),
              name,
              resolvedType: type,
              description: "",
              scopes: [],
              codeKey: null,
              valuesByMode: {},
            };
            collection.variables.push(variable);
          }
          if (spec.description !== undefined) variable.description = String(spec.description);
          if (Array.isArray(spec.scopes)) variable.scopes = spec.scopes as string[];
          if (typeof spec.codeKey === "string" && spec.codeKey) variable.codeKey = spec.codeKey;

          const defaultMode = spec.mode ? findMode(collection, String(spec.mode)) : fallback;
          if (spec.mode && !defaultMode) throw new Error(`Unknown mode "${String(spec.mode)}".`);
          for (const [key, value] of Object.entries(values ?? {})) {
            const mode = findMode(collection, key) ?? defaultMode;
            if (!mode) throw new Error(`Unknown mode "${key}" and no default mode given.`);
            variable.valuesByMode[mode.modeId] = valueShape(type, value);
          }

          results.push({
            id: variable.id,
            name: variable.name,
            action,
            resolvedType: variable.resolvedType,
            codeKey: variable.codeKey,
            codeKeySet: variable.codeKey !== null,
          });
        } catch (error) {
          errors.push({ name, message: (error as Error).message });
        }
      }

      return { collection: collectionPayload(collection), variables: results, errors };
    },

    rename_variable: (params) => {
      const collection = params.collection
        ? findCollection(String(params.collection))
        : collections.find((c) => c.variables.some((v) => v.id === params.id || v.name === params.name));
      if (!collection) throw new Error(`No collection holds variable "${String(params.name ?? params.id)}".`);

      const variable = collection.variables.find(
        (candidate) => candidate.id === params.id || (!params.id && candidate.name === params.name),
      );
      if (!variable) throw new Error(`Variable "${String(params.name ?? params.id)}" not found.`);

      const newName = String(params.newName ?? "");
      const clash = collection.variables.find((candidate) => candidate !== variable && candidate.name === newName);
      if (clash) throw new Error(`"${newName}" already exists in collection "${collection.name}".`);

      const previousName = variable.name;
      variable.name = newName;
      return {
        renamed: {
          id: variable.id,
          previousName,
          name: variable.name,
          collectionId: collection.id,
          collectionName: collection.name,
        },
      };
    },

    delete_variable: (params) => {
      const collection = params.collection ? findCollection(String(params.collection)) : null;
      const scope = collection ? [collection] : collections;
      const deleted: { id: string; name: string }[] = [];
      const missing: string[] = [];

      for (const id of (params.ids as string[] | undefined) ?? []) {
        const variable = scope.flatMap((c) => c.variables).find((v) => v.id === id);
        if (!variable) {
          missing.push(id);
          continue;
        }
        const owner = scope.find((c) => c.variables.includes(variable))!;
        owner.variables = owner.variables.filter((v) => v !== variable);
        deleted.push({ id: variable.id, name: variable.name });
      }
      for (const name of (params.names as string[] | undefined) ?? []) {
        const owner = scope.find((c) => c.variables.some((v) => v.name === name));
        const variable = owner?.variables.find((v) => v.name === name);
        if (!owner || !variable) {
          missing.push(name);
          continue;
        }
        owner.variables = owner.variables.filter((v) => v !== variable);
        deleted.push({ id: variable.id, name: variable.name });
      }
      return { deleted, missing };
    },
  };

  return { handlers, collections, nextId };
}

function inferType(value: unknown): string | null {
  if (typeof value === "number") return "FLOAT";
  if (typeof value === "boolean") return "BOOLEAN";
  if (typeof value === "string") return /^#([0-9a-f]{3,8})$/i.test(value) ? "COLOR" : "STRING";
  if (value && typeof value === "object" && "variable" in value) return "ALIAS";
  if (value && typeof value === "object" && "r" in value) return "COLOR";
  return null;
}

function valueShape(type: string, value: unknown): { type: string; value: unknown } {
  if (type === "ALIAS") return { type: "VARIABLE_ALIAS", value: String((value as { variable: string }).variable) };
  if (type === "COLOR" && typeof value === "string") {
    const hex = value.startsWith("#") ? value : "#000000";
    return {
      type: "COLOR",
      value: {
        r: parseInt(hex.slice(1, 3), 16) / 255,
        g: parseInt(hex.slice(3, 5), 16) / 255,
        b: parseInt(hex.slice(5, 7), 16) / 255,
        a: 1,
      },
    };
  }
  return { type, value };
}