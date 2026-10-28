import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ProjectService } from "../../../src/project.js";

/** Project paths are fixed by the local launcher, never supplied by tool arguments. */
export function registerProjectTools(server: McpServer, project: ProjectService): void {
  const add = <T extends z.ZodRawShape>(name: string, description: string, inputSchema: T, work: (args: z.output<z.ZodObject<T>>) => Promise<unknown>) => {
    server.registerTool(name, { description, inputSchema: inputSchema as z.ZodRawShape }, async (args: Record<string, unknown>): Promise<CallToolResult> => {
      try { return { content: [{ type: "text" as const, text: JSON.stringify(await work(args as z.output<z.ZodObject<T>>)) }] }; }
      catch (error) { return { isError: true, content: [{ type: "text" as const, text: (error as Error).message }] }; }
    });
  };
  add("project_status", "Read this local project's sync mode and recent activity.", {}, async () => ({ automatic: project.automatic(), activity: project.activity }));
  add('pending_document_approval', 'Inspect the open document awaiting plugin-only approval. Its link is a project routing claim, not verified URL identity. Present file name/key to the user.', {}, () => project.pendingDocument());
  add('approve_plugin_document', 'Only after explicit human consent: switch this project to plugin-only authorization and approve the currently pending document/connection. Pauses automatic sync, does not mutate Figma. Never approve automatically or reuse a prior launch ticket.', {fileKey:z.string().min(8),ticket:z.string().regex(/^[a-f0-9]{64}$/),optIn:z.literal(true)}, args => project.approveDocument(args.fileKey,args.ticket,args.optIn));
  add('require_strict_file_verification', 'After user request, require independently verified URL identity again. Pauses auto-sync and closes this project’s plugin-only connection. REST quotas apply.', {}, () => project.useStrictAuthorization());
  add("check_drift", "Check the configured code sources against the connected Figma file and write a drift report. Does not write to Figma.", {}, () => project.check());
  add("plan_sync", "Preview exact supported writes, conflicts, removed resources and missing descriptions. Present the result to the user before applying.", {selection:z.object({kind:z.enum(["token","component","style"]),key:z.string().min(1)}).optional()}, args => project.plan(args.selection));
  add("apply_sync", "Apply a previously reviewed, unexpired plan. Rejects stale plans. Enable automatic sync or replace Figma edits only when the user explicitly requested that choice.", {
    planId: z.string().min(1), enableAuto: z.boolean().optional(), overwriteConflicts: z.boolean().optional(),
  }, args => project.apply(args.planId, args));
  add('plan_token_import','Preview Figma variables as a new local Elf JSON token file. Preserves modes and alias source metadata, skips existing code names; never overwrites. Present content and limitations for review.',{path:z.string().optional(),ids:z.array(z.string()).max(5000).optional()},args => project.planTokenImport(args.path,args.ids));
  add('apply_token_import','Only after explicit user review: create the exact new token file from an unexpired import plan. Rejects source/Figma changes. No Figma writes; pauses automatic sync.',{planId:z.string().min(1)},args => project.applyTokenImport(args.planId));
  add("set_monitoring", "Pause automatic Figma writes while retaining drift monitoring.", {}, async () => { project.setMonitoring(); return { ok: true }; });
  add("prepare_component", "Read component source, available token references, variants and an editable initial Figma description for one local component. This is not a rendered reconstruction. Review and fill in design intent and token bindings.", { component: z.string().min(1) }, args => project.prepareComponent(args.component));
  add("list_project_components", "List discovered local components and their code keys without reading source into the response.", {}, () => project.listComponents());
  add("validate_component_description", "Validate a generated draft against its source revision, schema, variants and project token references. Does not save or write to Figma.", {
    component: z.string().min(1), description: z.record(z.string(), z.unknown()), reviewHash: z.string().regex(/^[a-f0-9]{64}$/),
  }, args => project.validateDescription(args.component, args.description, args.reviewHash));
  add("save_component_description", "Save an explicitly reviewed Figma description for a local component. Validates token references and paths. Pass the reviewHash from prepare_component to reject stale drafts. Pauses automatic sync; does not write to Figma. Use plan_sync next.", {
    component: z.string().min(1), description: z.record(z.string(), z.unknown()), reviewHash: z.string().regex(/^[a-f0-9]{64}$/),
  }, args => project.saveDescription(args.component, args.description, args.reviewHash));
}
