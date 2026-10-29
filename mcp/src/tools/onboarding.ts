import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import type {McpFigmaOnboarding} from '../../../src/mcp-figma-onboarding.js';

/** Local stdio only: these account, target and pairing tools are never public HTTP tools. */
export function registerFigmaOnboardingTools(server:McpServer,onboarding:McpFigmaOnboarding){
  const add=<T extends z.ZodRawShape>(name:string,description:string,inputSchema:T,work:(args:z.output<z.ZodObject<T>>)=>unknown|Promise<unknown>)=>{
    server.registerTool(name,{description,inputSchema:inputSchema as z.ZodRawShape},async(args:Record<string,unknown>):Promise<CallToolResult>=>{
      try{return {content:[{type:'text' as const,text:JSON.stringify(await work(args as z.output<z.ZodObject<T>>))}]};}
      catch(error){return {isError:true,content:[{type:'text' as const,text:(error as Error).message}]};}
    });
  };
  add('figma_onboarding_status','Inspect Figma account, selected MCP target, plugin readiness and the next onboarding action. No credentials returned; no writes.',{},()=>onboarding.status());
  add('connect_figma_account','After the user requests Figma sign-in: return an HTTPS authorization link using Elf’s existing OAuth service and a private loopback callback. Ask the user to open it; do not complete consent on their behalf. Does not return tokens or modify project configuration.',{},()=>onboarding.connect());
  add('select_figma_file','Only after the user supplies the intended Figma file URL and chooses new/existing and strict/plugin authorization: select a target for this MCP session. File names need not match the design system. Does not create a Figma file or redirect project drift monitoring. Choosing a target invalidates the previous selection identity; review future write plans again.',{url:z.string().max(2048),purpose:z.enum(['new','existing']),authorization:z.enum(['strict','plugin'])},args=>onboarding.select(args.url,args.purpose,args.authorization));
  add('get_figma_pairing_code','After selecting a target, request a fresh single-use pairing code for the local Elf Bridge plugin. Only reissue when needed: previously issued unused codes expire/revoke. Saved pairings may reconnect directly. No Figma design writes.',{},()=>onboarding.pairing());
  add('inspect_figma_target_approval','Inspect the selected target and fresh pending document approval ticket. Present the actual file name/key and authorization mode to the user before approving. A matching file name alone proves nothing.',{},()=>onboarding.pending());
  add('approve_figma_target','Only after explicit user confirmation of the exact selected document and plugin-only trust mode: approve the current pending connection. Supply the selectionId and ticket from inspection and matching fileKey. Does not rewrite project configuration or write design resources. Reconnect requires fresh approval.',{selectionId:z.string().uuid(),ticket:z.string().regex(/^[a-f0-9]{64}$/),fileKey:z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),approved:z.literal(true)},args=>onboarding.approve(args.selectionId,args.ticket,args.fileKey,args.approved));
}
