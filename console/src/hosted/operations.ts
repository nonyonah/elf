import { z } from 'zod';
import { componentTools } from '../../../mcp/src/tools/components.js';
import { variableTools } from '../../../mcp/src/tools/variables.js';
import { styleTools } from '../../../mcp/src/tools/styles.js';

// Reuse the local MCP schemas; never expose shell, filesystem or arbitrary-code tools.
const allowed = new Set(['list_collections', 'list_variables', 'list_components', 'get_node',
  'create_collection', 'upsert_variables', 'upsert_component', 'upsert_component_set',
  'upsert_text_style', 'upsert_effect_style']);
export const resourceTools = [...componentTools, ...variableTools, ...styleTools].filter(t => allowed.has(t.name));
export const writes = new Set(resourceTools.filter(t => /^(create|upsert)_/.test(t.name)).map(t => t.name));
export const writingOperationSchema = z.union(resourceTools.filter(t=>writes.has(t.name)).map(t=>
  z.object({method:z.literal(t.name),params:z.object(t.inputSchema).strict()}).strict()));
export const operationSchema = z.object({ method: z.string(), params: z.record(z.string(), z.unknown()) }).strict();
export type Operation = z.infer<typeof operationSchema>;
export function validateOperation(input: unknown, writing: boolean): Operation {
  const op = operationSchema.parse(input), tool = resourceTools.find(t => t.name === op.method);
  if (!tool || writes.has(op.method) !== writing) throw new Error('Unsupported operation');
  const params = z.object(tool.inputSchema).strict().parse(op.params);
  if (writing && ['upsert_component', 'upsert_component_set'].includes(op.method) && !params.codeKey) throw new Error('Hosted components require a stable codeKey');
  return { method: op.method, params };
}
