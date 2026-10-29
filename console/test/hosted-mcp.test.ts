import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { hostedFetch } from '../src/hosted/oauth.js';
import { hostedMcp } from '../src/hosted/mcp.js';
import { applyPlan, authenticatePlugin, connectPlugin, disconnect, pairCode, poll, preparePlan, queueRead, result } from '../src/hosted/relay.js';
import { hash, now } from '../src/hosted/common.js';
import type { Env } from '../src/env.js';

const bindings:Env={...env,HOSTED_MCP_ENABLED:'true',CONSOLE_ORIGIN:'https://console.test'};
const fileKey='eu8zGUOsrdyXXQqvJeyl1E';
const app=createApp({sessionResolver:async req=>req.headers.get('Authorization')==='Bearer human-a'?{userId:'user_a'}:req.headers.get('Authorization')==='Bearer human-b'?{userId:'user_b'}:null});
async function api(path:string,body?:unknown,who='human-a'){
  return app.request('https://console.test/api/hosted'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${who}`,'Content-Type':'application/json',Origin:'https://console.test'},...(body===undefined?{}:{body:JSON.stringify(body)})},bindings);
}
async function paired(approved=true){
  const code=await pairCode(bindings,'user_a',fileKey);
  const connected=await connectPlugin(bindings,{code:code.code,fileKey,fileName:'Untitled'},null);
  const authorization=`Bearer ${connected.session}`;
  await poll(bindings,await authenticatePlugin(bindings,authorization),connected.generation,'a'.repeat(64));
  if(approved)expect((await api(`/connections/${connected.connectionId}/approve`,{generation:connected.generation,fileKey,trust:'plugin'})).status).toBe(200);
  return {...connected,authorization,code:code.code};
}
async function plugin(auth:string){return authenticatePlugin(bindings,auth);}
async function approvedPlan(id:string){
  const plan=await preparePlan(bindings,'user_a',id,[{method:'create_collection',params:{name:'Color',modes:['Default']}}]);
  const c=await env.DB.prepare('SELECT generation FROM hosted_connections WHERE id=?').bind(id).first<{generation:string}>();
  expect((await api(`/plans/${plan.planId}/approve`,{hash:plan.hash,generation:c!.generation})).status).toBe(200);
  return plan;
}
beforeEach(async()=>{
  for(const table of ['hosted_operations','hosted_plans','hosted_connections','hosted_sources','hosted_consents'])await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("DELETE FROM rate_limits WHERE scope LIKE 'hosted:%'").run();
});

describe('hosted plugin isolation and review',()=>{
  it('consumes pairing once and scopes the session to its file',async()=>{
    const p=await paired(false);
    await expect(connectPlugin(bindings,{code:p.code,fileKey,fileName:'Untitled'},null)).rejects.toThrow();
    await expect(connectPlugin(bindings,{fileKey:'otherFile012345',fileName:'Other'},p.authorization)).rejects.toThrow();
    const stored=await env.DB.prepare('SELECT * FROM hosted_connections WHERE id=?').bind(p.connectionId).first();
    expect(JSON.stringify(stored)).not.toContain(p.session);
    expect(JSON.stringify(stored)).not.toContain(p.code);
    expect((await poll(bindings,await plugin(p.authorization),p.generation)).approved).toBe(false);
  });
  it('refuses expired pairing and cannot consume the code in another file',async()=>{
    const code=await pairCode(bindings,'user_a',fileKey);
    await expect(connectPlugin(bindings,{code:code.code,fileKey:'otherFile012345',fileName:'Other'},null)).rejects.toThrow();
    await env.DB.prepare('UPDATE hosted_connections SET codeExpires=0 WHERE id=?').bind(code.connectionId).run();
    await expect(connectPlugin(bindings,{code:code.code,fileKey,fileName:'Untitled'},null)).rejects.toThrow();
  });
  it('separates human approval from MCP and other users',async()=>{
    const p=await paired(false);
    expect((await api(`/connections/${p.connectionId}`,undefined,'human-b')).status).toBe(400);
    expect((await api(`/connections/${p.connectionId}/approve`,{generation:p.generation,fileKey,trust:'plugin'},'mcp-token')).status).toBe(401);
    expect((await api(`/connections/${p.connectionId}/approve`,{generation:p.generation,fileKey:'otherFile012345',trust:'plugin'})).status).toBe(400);
    await expect(queueRead(bindings,'user_b',p.connectionId,{method:'list_collections',params:{}})).rejects.toThrow();
    await expect(queueRead(bindings,'user_a',p.connectionId,{method:'list_collections',params:{}})).rejects.toThrow();
  });
  it('requires approval of the exact plan hash and refuses scripts and unknown fields',async()=>{
    const p=await paired();
    await expect(preparePlan(bindings,'user_a',p.connectionId,[{method:'eval',params:{code:'bad'}}])).rejects.toThrow();
    await expect(preparePlan(bindings,'user_a',p.connectionId,[{method:'create_collection',params:{name:'Color',script:'bad'}}])).rejects.toThrow();
    await expect(preparePlan(bindings,'user_a',p.connectionId,[{method:'upsert_component',params:{name:'Button'}}])).rejects.toThrow('codeKey');
    const plan=await preparePlan(bindings,'user_a',p.connectionId,[{method:'create_collection',params:{name:'Color'}}]);
    await expect(applyPlan(bindings,'user_a',plan.planId)).rejects.toThrow('Approve');
    expect((await api(`/plans/${plan.planId}/approve`,{hash:'a'.repeat(64),generation:p.generation})).status).toBe(400);
  });
  it('serializes dispatch and makes repeated apply return existing jobs',async()=>{
    const p=await paired(),plan=await approvedPlan(p.connectionId);
    const first=await applyPlan(bindings,'user_a',plan.planId),second=await applyPlan(bindings,'user_a',plan.planId);
    expect(second.jobs).toEqual(first.jobs);
    const command=await poll(bindings,await plugin(p.authorization),p.generation);
    expect(command.command?.method).toBe('create_collection');
    expect((await poll(bindings,await plugin(p.authorization),p.generation)).command).toBeNull();
    await result(bindings,await plugin(p.authorization),p.generation,command.command!.id,{ok:true,result:{collection:{id:'VariableCollectionId:1',name:'Color'}}});
    await expect(result(bindings,await plugin(p.authorization),p.generation,command.command!.id,{ok:true})).rejects.toThrow();
  });
  it('rejects cross-connection results and cancels dependent writes after failure',async()=>{
    const p=await paired(),q=await paired();
    const plan=await preparePlan(bindings,'user_a',p.connectionId,[{method:'create_collection',params:{name:'Color'}},{method:'create_collection',params:{name:'Spacing'}}]);
    await api(`/plans/${plan.planId}/approve`,{hash:plan.hash,generation:p.generation});await applyPlan(bindings,'user_a',plan.planId);
    const cmd=(await poll(bindings,await plugin(p.authorization),p.generation)).command!;
    await expect(result(bindings,await plugin(q.authorization),q.generation,cmd.id,{ok:true})).rejects.toThrow();
    await result(bindings,await plugin(p.authorization),p.generation,cmd.id,{ok:false,error:{message:'Failed'}});
    expect((await poll(bindings,await plugin(p.authorization),p.generation)).command).toBeNull();
    const jobs=await env.DB.prepare('SELECT state FROM hosted_operations WHERE planId=? ORDER BY ordinal').bind(plan.planId).all<{state:string}>();
    expect(jobs.results.map(j=>j.state)).toEqual(['failed','cancelled']);
  });
  it('marks in-flight outcomes unknown on reconnect and invalidates old approval',async()=>{
    const p=await paired(),plan=await approvedPlan(p.connectionId);
    await applyPlan(bindings,'user_a',plan.planId);const cmd=(await poll(bindings,await plugin(p.authorization),p.generation)).command!;
    const reconnected=await connectPlugin(bindings,{fileKey,fileName:'Untitled'},p.authorization);
    expect(reconnected.generation).not.toBe(p.generation);
    const row=await env.DB.prepare('SELECT state FROM hosted_operations WHERE id=?').bind(cmd.id).first<{state:string}>();
    expect(row?.state).toBe('unknown');
    await expect(poll(bindings,await plugin(p.authorization),p.generation)).rejects.toThrow();
    await expect(applyPlan(bindings,'user_a',plan.planId)).rejects.toThrow();
  });
  it('revokes saved plugin access on disconnect',async()=>{
    const p=await paired();await disconnect(bindings,'user_a',p.connectionId);
    await expect(authenticatePlugin(bindings,p.authorization)).rejects.toThrow();
  });
  it('blocks stale queues and does not retry a timed-out write',async()=>{
    const p=await paired(),plan=await approvedPlan(p.connectionId);
    await applyPlan(bindings,'user_a',plan.planId);const cmd=(await poll(bindings,await plugin(p.authorization),p.generation)).command!;
    await env.DB.prepare('UPDATE hosted_operations SET expires=0 WHERE id=?').bind(cmd.id).run();
    expect((await poll(bindings,await plugin(p.authorization),p.generation)).command).toBeNull();
    expect((await env.DB.prepare('SELECT state FROM hosted_operations WHERE id=?').bind(cmd.id).first<{state:string}>())?.state).toBe('unknown');
  });
  it('rejects a changed page snapshot before apply',async()=>{
    const p=await paired(),plan=await approvedPlan(p.connectionId);
    await poll(bindings,await plugin(p.authorization),p.generation,'b'.repeat(64));
    await expect(applyPlan(bindings,'user_a',plan.planId)).rejects.toThrow('stale');
  });
  it('keeps dispatch paused while the plugin is returning an operation result',async()=>{
    const p=await paired();await queueRead(bindings,'user_a',p.connectionId,{method:'list_collections',params:{}});
    expect((await poll(bindings,await plugin(p.authorization),p.generation,undefined,true)).command).toBeNull();
    expect((await poll(bindings,await plugin(p.authorization),p.generation)).command?.method).toBe('list_collections');
  });
  it('stops after a partial variable failure',async()=>{
    const p=await paired(),plan=await approvedPlan(p.connectionId);await applyPlan(bindings,'user_a',plan.planId);
    const cmd=(await poll(bindings,await plugin(p.authorization),p.generation)).command!;
    await result(bindings,await plugin(p.authorization),p.generation,cmd.id,{ok:true,result:{variables:[],errors:[{message:'Unknown mode'}]}});
    expect((await env.DB.prepare('SELECT state FROM hosted_operations WHERE id=?').bind(cmd.id).first<{state:string}>())?.state).toBe('failed');
  });
  it('rejects an expired Markdown source when applying its plan',async()=>{
    const p=await paired();
    const plan=await preparePlan(bindings,'user_a',p.connectionId,[{method:'create_collection',params:{name:'Color'}}],'c'.repeat(64));
    await api(`/plans/${plan.planId}/approve`,{hash:plan.hash,generation:p.generation});
    await expect(applyPlan(bindings,'user_a',plan.planId)).rejects.toThrow('source review expired');
  });
});

describe('hosted MCP transport',()=>{
  async function served(path:string,init?:RequestInit){
    const ctx=createExecutionContext();
    const response=await hostedFetch(new Request('https://console.test'+path,init),bindings,ctx,app);
    await waitOnExecutionContext(ctx);return response;
  }
  it('completes browser-bound OAuth with PKCE and rejects replay and wrong audiences',async()=>{
    const registration=await served('/oauth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Elf test client',redirect_uris:['https://client.test/callback'],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'})});
    expect(registration.status).toBe(201);
    const client=await registration.json() as {client_id:string};
    const verifier='v'.repeat(64);
    const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)));
    const challenge=btoa(String.fromCharCode(...digest)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const query=new URLSearchParams({client_id:client.client_id,redirect_uri:'https://client.test/callback',response_type:'code',scope:'elf:read elf:write',resource:'https://console.test/mcp',state:'test-state',code_challenge:challenge,code_challenge_method:'S256'}).toString();
    for(const badQuery of [query.replace('S256','plain'),query.replace(encodeURIComponent('https://client.test/callback'),encodeURIComponent('https://attacker.test/callback'))]){
      const refused=await served('/api/hosted/consent/start',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer human-a',Origin:'https://console.test'},body:JSON.stringify({query:badQuery})});
      expect(refused.status).toBe(400);
    }
    const start=await served('/api/hosted/consent/start',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer human-a',Origin:'https://console.test'},body:JSON.stringify({query})});
    expect(start.status).toBe(200);
    const consent=await start.json() as {handle:string};
    const cookie=start.headers.get('Set-Cookie')!.split(';')[0];
    const finish=await served('/api/hosted/consent/finish',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer human-a',Cookie:cookie,Origin:'https://console.test'},body:JSON.stringify({handle:consent.handle,approve:true})});
    expect(finish.status).toBe(200);
    const destination=new URL((await finish.json() as {redirectTo:string}).redirectTo);
    expect(destination.origin).toBe('https://client.test');expect(destination.searchParams.get('state')).toBe('test-state');
    const tokenBody=new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,redirect_uri:'https://client.test/callback',code:destination.searchParams.get('code')!,code_verifier:verifier,resource:'https://console.test/mcp'});
    const tokenResponse=await served('/oauth/token',{method:'POST',body:tokenBody});
    expect(tokenResponse.status).toBe(200);
    const token=await tokenResponse.json() as {access_token:string;refresh_token:string};
    expect(token.access_token).toBeTruthy();
    const mcp=await served('/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:`Bearer ${token.access_token}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
    expect(mcp.status).toBe(200);
    const wrongResource=await served('/oauth/token',{method:'POST',body:new URLSearchParams({grant_type:'refresh_token',refresh_token:token.refresh_token,client_id:client.client_id,resource:'https://attacker.test/mcp'})});
    expect(wrongResource.status).not.toBe(200);
    expect((await served('/oauth/token',{method:'POST',body:tokenBody})).status).not.toBe(200);
    const replay=await served('/api/hosted/consent/finish',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer human-a',Cookie:cookie,Origin:'https://console.test'},body:JSON.stringify({handle:consent.handle,approve:true})});
    expect(replay.status).toBe(400);
  });
  async function call(name:string,args:Record<string,unknown>,owner='user_a',scopes=['elf:read','elf:write']){
    const response=await hostedMcp(new Request('https://console.test/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}),bindings,owner,scopes);
    return await response.json() as {result:{isError?:boolean;content:{text:string}[]}};
  }
  it('accepts bounded content without a filesystem and scopes reviews to the owner',async()=>{
    const prepared=await call('prepare_design_system',{markdown:'# Test\nColor: #112233'});
    const review=JSON.parse(prepared.result.content[0].text);
    expect(review.sourceHash).toBe(await hash('# Test\nColor: #112233'));
    const invalid=await call('validate_design_system',{reviewId:review.reviewId,draft:{schema:1,name:'Test',documentation:'',collections:[],components:[],questions:[],assumptions:[],unsupported:[]}},'user_b');
    expect(invalid.result.isError).toBe(true);
    const forbidden=await call('get_figma_pairing_code',{url:`https://www.figma.com/design/${fileKey}/Untitled`},'user_a',['elf:read']);
    expect(forbidden.result.isError).toBe(true);
  });
  it('does not expose raw writes or local project tools',async()=>{
    const response=await hostedMcp(new Request('https://console.test/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})}),bindings,'user_a',['elf:read']);
    const body=await response.json() as {result:{tools:{name:string}[]}};
    const names=body.result.tools.map(t=>t.name);
    expect(names).toContain('prepare_figma_changes');expect(names).not.toContain('upsert_component');expect(names).not.toContain('apply_sync');
  });
  it('keeps the connector disabled by default and publishes audience metadata when enabled',async()=>{
    const ctx=createExecutionContext();
    const disabled=await hostedFetch(new Request('https://console.test/mcp'),{...bindings,HOSTED_MCP_ENABLED:'false'},ctx,app);
    expect(disabled.status).toBe(404);
    const metadata=await hostedFetch(new Request('https://console.test/.well-known/oauth-protected-resource/mcp'),bindings,ctx,app);
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({resource:'https://console.test/mcp'});
    await waitOnExecutionContext(ctx);
  });
});
