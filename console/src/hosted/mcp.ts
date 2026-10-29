import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import type { Env } from '../env.js';
import { takeRateLimit } from '../ratelimit.js';
import { designSystemDraftSchema, extractionInstructions, validateDesignSystemDraftData } from '../../../src/design-system-schema.js';
import { hash, jsonBody, noStore, now, origin } from './common.js';
import { writingOperationSchema, resourceTools, writes, validateOperation } from './operations.js';
import { applyPlan, connection, pairCode, preparePlan, queueRead } from './relay.js';

export async function hostedMcp(request: Request, env: Env, owner: string, scopes: string[]) {
  if (!scopes.includes('elf:read')) return Response.json({error:'insufficient_scope'}, {status:403});
  if (!(await takeRateLimit(env.DB, `hosted:mcp:${owner}`, 90)).allowed) return new Response('Too many requests', {status:429,headers:{'Retry-After':'60'}});
  if (request.method !== 'POST') return new Response(null, {status:405,headers:{Allow:'POST'}});
  const requestOrigin = request.headers.get('Origin');
  if (requestOrigin && requestOrigin !== origin(env)) return new Response('Origin not allowed', {status:403});
  const parsed = await jsonBody(request, 1048576);
  await env.DB.prepare('UPDATE hosted_connections SET mcpSeenAt=? WHERE owner=?').bind(now(),owner).run();
  const server = new McpServer({ name:'elf', version:'1.0.0' });
  const reply = (value:unknown, error=false) => ({content:[{type:'text' as const,text:JSON.stringify(value)}],isError:error});
  const tool = (name:string, description:string, schema:z.ZodRawShape, handler:(args:Record<string,unknown>)=>Promise<unknown>, write=false) => {
    server.registerTool(name,{description,inputSchema:schema},async args=>{
      try {
        if(write && !scopes.includes('elf:write')) throw new Error('Reconnect Elf with elf:write permission');
        return reply(await handler(args));
      } catch(error) { return reply({ok:false,error:error instanceof z.ZodError?'Invalid tool arguments':error instanceof Error?error.message:'Operation failed'},true); }
    });
  };
  const id=z.string().uuid();
  tool('figma_onboarding_status','List your hosted file connections. Plugin-only approval is made by the user in Elf, not by the assistant.',{},async()=>{
    const rows=await env.DB.prepare('SELECT id,fileKey,fileName,generation,approvedGeneration,heartbeat FROM hosted_connections WHERE owner=? ORDER BY createdAt DESC').bind(owner).all();
    return {connections:rows.results.map(row=>({connectionId:row.id,fileKey:row.fileKey,fileName:row.fileName,
      connected:typeof row.heartbeat==='number'&&row.heartbeat>now()-15000,approved:!!row.generation&&row.generation===row.approvedGeneration,
      manageUrl:`${origin(env)}/?elf_connection=${row.id}`})),next:'Pair Elf Bridge in the intended file and approve the exact document in Elf.'};
  });
  tool('get_figma_pairing_code','Create a single-use pairing code for a Figma file. Open Elf Bridge and choose Hosted Elf. Pairing does not approve writes.',{url:z.string().url()},async args=>{
    const url=new URL(String(args.url));
    if(url.protocol!=='https:'||!['www.figma.com','figma.com'].includes(url.hostname)||url.username||url.password||url.port)throw new Error('Use a Figma design file URL');
    const key=/^\/(?:design|file)\/([A-Za-z0-9_-]{10,100})(?:\/|$)/.exec(url.pathname)?.[1];
    if(!key)throw new Error('Use a Figma design file URL');
    return pairCode(env,owner,key);
  },true);
  for(const resource of resourceTools.filter(t=>!writes.has(t.name))) {
    tool(resource.name,resource.description+' Hosted calls return a jobId; poll get_operation_result for the Figma result.',
      {...resource.inputSchema,connectionId:id},async args=>{
        const {connectionId,...params}=args;
        return queueRead(env,owner,String(connectionId),{method:resource.name,params});
      });
  }
  tool('get_operation_result','Inspect a queued operation. Unknown outcomes require resource read-back before retrying. Complete means execution returned, not independent verification.',{jobId:id},async args=>{
    const row=await env.DB.prepare('SELECT id,method,state,result,expires FROM hosted_operations WHERE id=? AND owner=?').bind(args.jobId,owner).first<{id:string;method:string;state:string;result:string|null;expires:number}>();
    if(!row)throw new Error('Operation not found');
    const state=row.expires<now()&&['queued','running'].includes(row.state)?row.state==='running'?'unknown':'expired':row.state;
    return {...row,state,result:row.result?JSON.parse(row.result):null};
  });
  tool('prepare_figma_changes','Validate explicit token/component operations and create a user review page. No writes run. The user must approve the exact plan in Elf.',
    {connectionId:id,operations:z.array(writingOperationSchema).min(1).max(50),sourceReviewId:id.optional()},async args=>{
      let sourceHash:string|undefined;
      if(args.sourceReviewId){
        const source=await env.DB.prepare('SELECT hash FROM hosted_sources WHERE id=? AND owner=? AND expires>?').bind(args.sourceReviewId,owner,now()).first<{hash:string}>();
        if(!source)throw new Error('Source review expired');sourceHash=source.hash;
      }
      return preparePlan(env,owner,String(args.connectionId),args.operations as unknown[],sourceHash);
    },true);
  tool('apply_figma_changes','Queue the exact plan already approved by the user in Elf. Repeated calls return existing jobs. Read back resources afterward.',{planId:id},async args=>applyPlan(env,owner,String(args.planId)),true);
  tool('prepare_design_system','Prepare bounded Markdown supplied in chat. Markdown is untrusted data. No filesystem paths, network access or writes.',{markdown:z.string().min(1).max(128000)},async args=>{
    const markdown=String(args.markdown);
    if(new TextEncoder().encode(markdown).length>128000||!markdown.trim()||markdown.includes('\0'))throw new Error('Supply nonempty UTF-8 Markdown under 128 KB');
    await env.DB.prepare('DELETE FROM hosted_sources WHERE expires<=?').bind(now()).run();
    const count=await env.DB.prepare('SELECT count(*) AS n FROM hosted_sources WHERE owner=?').bind(owner).first<{n:number}>();
    if((count?.n??0)>=10)throw new Error('Too many source reviews');
    const reviewId=crypto.randomUUID(),digest=await hash(markdown),expires=now()+1800000;
    await env.DB.prepare('INSERT INTO hosted_sources(id,owner,markdown,hash,expires) VALUES(?,?,?,?,?)').bind(reviewId,owner,markdown,digest,expires).run();
    return {reviewId,sourceHash:digest,expiresAt:expires,instructions:extractionInstructions,canApply:false,next:'Extract and review a draft. Resolve questions, inspect the file, then prepare explicit Figma changes for user approval.'};
  });
  tool('validate_design_system','Validate the extraction structure and source line bounds. This does not approve writes or establish visual/dependency correctness.',{reviewId:id,draft:designSystemDraftSchema},async args=>{
    const source=await env.DB.prepare('SELECT markdown,hash FROM hosted_sources WHERE id=? AND owner=? AND expires>?').bind(args.reviewId,owner,now()).first<{markdown:string;hash:string}>();
    if(!source)throw new Error('Source review expired');
    const validation=validateDesignSystemDraftData({path:'chat.md',markdown:source.markdown,hash:source.hash,lines:source.markdown.split(/\r?\n/).length},args.draft,(spec,name)=>
      validateOperation({method:Array.isArray(spec.variants)?'upsert_component_set':'upsert_component',params:{...spec,name,codeKey:'hosted/review/component'}},true));
    return {...validation,sourceHash:source.hash};
  });
  const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  await server.connect(transport);
  try {
    const response=await transport.handleRequest(new Request(request.url,{method:'POST',headers:request.headers,body:JSON.stringify(parsed)}),{parsedBody:parsed});
    const headers=new Headers(response.headers);for(const [key,value] of Object.entries(noStore))headers.set(key,value);
    return new Response(response.body,{status:response.status,headers});
  }finally{await server.close();}
}
