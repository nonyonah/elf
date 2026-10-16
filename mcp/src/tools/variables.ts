import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PluginClient } from "../client.js";
import {
  type PluginCollection,
  type PluginUpsertResult,
  type PluginVariable,
  variableScopeSchema,
  variableTypeSchema,
} from "../plugin-types.js";
import { registerTools, type AnyToolDefinition, type ToolDefinition, type ToolPayload } from "./registry.js";

/** What each plugin method hands back, as seen from this side. */
interface CollectionsResult {
  collections: PluginCollection[];
}

interface VariablesResult {
  variables: PluginVariable[];
}

interface CollectionResult {
  collection: PluginCollection;
}

interface UpsertResult {
  collection: PluginCollection;
  variables: PluginUpsertResult[];
  errors: { name: string; message: string }[];
}

interface RenameResult {
  renamed: { id: string; previousName: string; name: string; collectionId: string; collectionName: string };
}

interface DeleteResult {
  deleted: { id: string; name: string }[];
  missing: string[];
}

const valueSchema = z.union([
  z.string().describe('STRING value, or a color as "#rrggbb" / "#rrggbbaa" / "rgb(…)" when type is COLOR.'),
  z.number().describe("FLOAT value."),
  z.boolean().describe("BOOLEAN value."),
  z.object({ variable: z.string() }).describe('Alias to another variable, by name or "collection/name".'),
  z
    .object({ r: z.number(), g: z.number(), b: z.number(), a: z.number().optional() })
    .describe("COLOR value as channels in the 0–1 range."),
]);

const variableSpec = z.object({
  name: z
    .string()
    .describe('Variable name, unique inside the collection — the upsert key, e.g. "color/primary/500".'),
  type: variableTypeSchema
    .optional()
    .describe(
      "Resolved type. Inferred from the first value when omitted. Figma types are immutable, so giving a " +
        "different type for an existing variable is an error — delete it first.",
    ),
  codeKey: z
    .string()
    .optional()
    .describe(
      'Code-side key stored as shared plugin data (namespace "elf", key "codeKey"). This is what the ' +
        "later code↔Figma manifest will match on.",
    ),
  description: z.string().optional().describe("Variable description."),
  mode: z
    .string()
    .optional()
    .describe(
      "Mode name or id used for any value key that is not a mode of the collection " +
        "(defaults to the collection's default mode).",
    ),
  scopes: z.array(variableScopeSchema).optional().describe("Figma variable scopes."),
  values: z
    .record(valueSchema)
    .describe("Values keyed by mode name or mode id. Modes left out keep their current value."),
});

export const listCollectionsTool: ToolDefinition<z.ZodRawShape> = {
  name: "list_collections",
  title: "Elf: list variable collections",
  description:
    "List every local variable collection in the open Figma file, with its modes, default mode and variable count.",
  inputSchema: {},
  handler: async (client: PluginClient): Promise<ToolPayload> => {
    const result = await client.call<CollectionsResult>("list_collections");
    return {
      ok: true,
      collections: result.collections,
      collectionCount: result.collections.length,
    };
  },
};

export const listVariablesTool: ToolDefinition<{
  collection: z.ZodOptional<z.ZodString>;
  type: z.ZodOptional<typeof variableTypeSchema>;
}> = {
  name: "list_variables",
  title: "Elf: list variables",
  description:
    "List local variables in the open Figma file, optionally filtered by collection name/id and by " +
    "resolved type. Returns the value of every mode plus the stored codeKey.",
  inputSchema: {
    collection: z
      .string()
      .optional()
      .describe("Collection name or id. Omit to list variables from every collection."),
    type: variableTypeSchema.optional().describe("Filter by resolved type."),
  },
  handler: async (client: PluginClient, args): Promise<ToolPayload> => {
    const result = await client.call<VariablesResult>("list_variables", {
      collection: args.collection,
      type: args.type,
    });
    return { ok: true, variables: result.variables, variableCount: result.variables.length };
  },
};

export const createCollectionTool: ToolDefinition<{
  name: z.ZodString;
  modes: z.ZodOptional<z.ZodArray<z.ZodString>>;
}> = {
  name: "create_collection",
  title: "Elf: create variable collection",
  description:
    "Create a local variable collection. Re-running with an existing name returns that collection and " +
    "only adds modes that are missing — never duplicates.",
  inputSchema: {
    name: z.string().describe('Collection name, e.g. "Core".'),
    modes: z
      .array(z.string())
      .optional()
      .describe('Mode names, e.g. ["Light", "Dark"]. Defaults to a single "Mode 1".'),
  },
  handler: async (client: PluginClient, args): Promise<ToolPayload> => {
    const result = await client.call<CollectionResult>("create_collection", {
      name: args.name,
      modes: args.modes,
    });
    return { ok: true, collection: result.collection };
  },
};

export const upsertVariablesTool: ToolDefinition<{
  collection: z.ZodString;
  variables: z.ZodArray<typeof variableSpec>;
  defaultMode: z.ZodOptional<z.ZodString>;
}> = {
  name: "upsert_variables",
  title: "Elf: upsert variables",
  description:
    "Create or update variables in a collection, matched by name — running this twice updates, never " +
    "duplicates. Takes an array so a whole token file can go in one call. Each variable's codeKey is " +
    "stored as shared plugin data (namespace \"elf\", key \"codeKey\"). Per-item failures (wrong type, " +
    "unknown mode) are reported in `errors`; everything that succeeded still returns its Figma id.",
  inputSchema: {
    collection: z.string().describe("Target collection name or id."),
    variables: z.array(variableSpec).describe("Variables to create or update, applied in order."),
    defaultMode: z
      .string()
      .optional()
      .describe("Fallback mode name/id for variables that don't set `mode` themselves."),
  },
  handler: async (client: PluginClient, args): Promise<ToolPayload> => {
    const result = await client.call<UpsertResult>("upsert_variables", {
      collection: args.collection,
      defaultMode: args.defaultMode,
      variables: args.variables,
    });

    const payload: ToolPayload = {
      ok: result.errors.length === 0,
      collection: result.collection,
      variables: result.variables,
      created: result.variables.filter((variable) => variable.action === "created").length,
      updated: result.variables.filter((variable) => variable.action === "updated").length,
    };
    if (result.errors.length > 0) {
      payload.error = `${result.errors.length} variable(s) failed, ${result.variables.length} succeeded.`;
      payload.errors = result.errors;
    }
    return payload;
  },
};

export const renameVariableTool: ToolDefinition<{
  collection: z.ZodOptional<z.ZodString>;
  name: z.ZodOptional<z.ZodString>;
  id: z.ZodOptional<z.ZodString>;
  newName: z.ZodString;
}> = {
  name: "rename_variable",
  title: "Elf: rename variable",
  description:
    "Rename one variable, found by id or by name (optionally scoped to a collection). Idempotent — " +
    "renaming to the current name changes nothing. Fails when another variable in the collection already " +
    "has the new name, because Figma would then hold two variables with the same name.",
  inputSchema: {
    collection: z.string().optional().describe("Collection name or id, to disambiguate the lookup."),
    name: z.string().optional().describe('Current variable name, e.g. "color/primary".'),
    id: z.string().optional().describe("Current variable id. Takes precedence over `name`."),
    newName: z.string().describe("New variable name."),
  },
  handler: async (client: PluginClient, args): Promise<ToolPayload> => {
    if (!args.id && !args.name) {
      return { ok: false, error: "Provide either `id` or `name` to identify the variable." };
    }
    const result = await client.call<RenameResult>("rename_variable", {
      collection: args.collection,
      name: args.name,
      id: args.id,
      newName: args.newName,
    });
    return { ok: true, variable: result.renamed };
  },
};

export const deleteVariableTool: ToolDefinition<{
  collection: z.ZodOptional<z.ZodString>;
  names: z.ZodOptional<z.ZodArray<z.ZodString>>;
  ids: z.ZodOptional<z.ZodArray<z.ZodString>>;
}> = {
  name: "delete_variable",
  title: "Elf: delete variables",
  description:
    "Delete variables by id and/or by name. Both take arrays so a batch can go in one call; names that " +
    "match nothing are reported under `missing` instead of failing the call.",
  inputSchema: {
    collection: z.string().optional().describe("Collection name or id to scope name lookups to."),
    names: z.array(z.string()).optional().describe("Variable names to delete."),
    ids: z.array(z.string()).optional().describe("Variable ids to delete."),
  },
  handler: async (client: PluginClient, args): Promise<ToolPayload> => {
    if (!args.ids?.length && !args.names?.length) {
      return { ok: false, error: "Provide `ids` and/or `names` — nothing to delete." };
    }
    const result = await client.call<DeleteResult>("delete_variable", {
      collection: args.collection,
      names: args.names,
      ids: args.ids,
    });
    return {
      ok: true,
      deleted: result.deleted,
      deletedCount: result.deleted.length,
      missing: result.missing,
    };
  },
};

export const variableTools: AnyToolDefinition[] = [
  listCollectionsTool,
  listVariablesTool,
  createCollectionTool,
  upsertVariablesTool,
  renameVariableTool,
  deleteVariableTool,
];

export function registerVariableTools(server: McpServer, client: PluginClient): void {
  registerTools(server, client, variableTools);
}