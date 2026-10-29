import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {McpFigmaOnboarding,parseFigmaFileUrl} from '../src/mcp-figma-onboarding.js';
import {createSettingsServer,type SettingsServerHandle} from '../src/settings.js';
import {readFigmaAccount,removeFigmaAccount} from '../src/figma/account.js';

const key='new_file_12345',other='other_file_12345',ticket='a'.repeat(64);

test('fresh-project stdio exposes onboarding and Markdown preview without creating configuration', {timeout:120_000}, async()=>{
 const root=mkdtempSync(join(tmpdir(),'elf-mcp-fresh-'));
 writeFileSync(join(root,'system.md'),'# Example\n\nA small design system.\n');
 const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>typeof entry[1]==='string'));
 Object.assign(env,{ELF_MCP_TOKEN:'isolated-onboarding-test-token',ELF_MCP_PORT:'0',ELF_FIGMA_ACCOUNT_PATH:join(root,'account.json')});
 const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../bin/elf-tokens.js',import.meta.url)),'mcp','--project',root],cwd:root,env,stderr:'pipe'});
 const client=new Client({name:'onboarding-test',version:'1.0.0'});
 const call=async(name:string,args:Record<string,unknown>={})=>client.callTool({name,arguments:args});
 const data=(result:any)=>JSON.parse(result.content[0].text);
 try{
  await client.connect(transport);
  const names=(await client.listTools()).tools.map(tool=>tool.name);
  for(const name of ['figma_onboarding_status','connect_figma_account','select_figma_file','get_figma_pairing_code','inspect_figma_target_approval','approve_figma_target','prepare_design_system'])assert.ok(names.includes(name),name);
  assert.equal(data(await call('figma_onboarding_status')).nextAction,'select_figma_file');
  const selected=data(await call('select_figma_file',{url:`https://figma.com/design/${key}/Untitled`,purpose:'new',authorization:'plugin'}));
  assert.equal(selected.target.fileKey,key);assert.equal(selected.ready,false);
  const preview=await call('prepare_design_system',{path:'system.md'});assert.notEqual(preview.isError,true);
  const blocked=await call('list_variables');assert.equal(blocked.isError,true);assert.match(JSON.stringify(blocked),/onboarding is incomplete/);
  assert.deepEqual(readdirSync(root),['system.md']);
 }finally{await client.close();await transport.close();rmSync(root,{recursive:true,force:true});}
});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'elf-mcp-onboarding-')),config=join(root,'elf.config.json');
 writeFileSync(join(root,'tokens.css'),':root{}');
 writeFileSync(config,JSON.stringify({figma:{fileKey:other,source:'bridge',authorization:'strict'},codebase:{path:'tokens.css',source:'css'}}));
 const status:any={connected:true,file:{key,name:'Untitled',authorization:'plugin',authorizationId:'approval-1'},connectedAt:'2026-10-29T00:00:00Z',pendingApproval:null};
 const calls:any[]=[],locks:any[]=[];let pending:any=null;
 const client={call:async(method:string,params:unknown)=>{calls.push({method,params});return {variables:[]};},request:async(method:string,params:unknown)=>client.call(method,params)};
 const runtime:any={connection:{get status(){return status;},get isConnected(){return status.connected;},onStatus:()=>()=>{}},refreshPairingCode:async()=>({code:'123456',expiresAt:Date.now()+60_000}),transaction:async(fileKey:string,work:any,options:any)=>{locks.push({fileKey,options});return work(client);},control:async(method:string,params:any)=>{
  if(method==='__elf_document_pending')return pending;
  if(method==='__elf_document_approve'){
   assert.equal(params.fileKey,pending.file.key);assert.equal(params.ticket,pending.ticket);
   status.file={...pending.file,authorization:'plugin',authorizationId:'approval-2'};pending=null;status.pendingApproval=null;return {ok:true};
  }
  throw Error('Unexpected control method');
 }};
 return {root,config,status,calls,locks,runtime,pending:(value:any)=>{pending=value;status.pendingApproval=value?value.file:null;},cleanup:()=>rmSync(root,{recursive:true,force:true})};
}

test('Figma URL parsing uses the exact key; names, fragments and node selections do not identify the document',()=>{
 assert.deepEqual(parseFigmaFileUrl(`https://www.figma.com/design/${key}/Untitled?node-id=1-2#hello`),{fileKey:key,url:`https://www.figma.com/design/${key}`});
 assert.equal(parseFigmaFileUrl(`https://figma.com/file/${key}/Different-name`).fileKey,key);
 for(const bad of [`http://figma.com/design/${key}`,`https://figma.com.evil.test/design/${key}`,`https://user@figma.com/design/${key}`,`https://figma.com:1234/design/${key}`,`https://figma.com/design/${key}%2Fbad`,'file:///etc/passwd','https://figma.com/design/short'])assert.throws(()=>parseFigmaFileUrl(bad));
});
test('new and existing targets are session-only and cannot redirect configured project monitoring',async()=>{
 const f=fixture();const service=new McpFigmaOnboarding(f.runtime,f.config,{account:()=>null});try{
  const before=readFileSync(f.config,'utf8');
  let state=service.select(`https://figma.com/design/${key}/Rift-Labs`,'new','plugin');
  assert.equal(state.ready,true);assert.equal(state.bridge.file?.name,'Untitled');assert.equal(state.projectFileKey,other);
  await service.connection().request('list_variables');assert.equal(f.locks[0].fileKey,key);assert.equal(f.calls[0].method,'list_variables');
  const oldId=state.target!.id;state=service.select(`https://figma.com/design/${key}/Renamed`,'existing','plugin');assert.notEqual(state.target!.id,oldId);
  assert.equal(readFileSync(f.config,'utf8'),before);
 }finally{await service.close();f.cleanup();}
});
test('wrong file, missing account and strict downgrade prevent both reads and writes before bridge calls',async()=>{
 const f=fixture(),service=new McpFigmaOnboarding(f.runtime,f.config,{account:()=>null});try{
  service.select(`https://figma.com/design/${other}`,'existing','plugin');await assert.rejects(service.connection().request('list_variables'),/onboarding is incomplete/);
  service.select(`https://figma.com/design/${key}`,'new','strict');assert.equal(service.status().nextAction,'connect_figma_account');await assert.rejects(service.transaction(async client=>client.call('upsert_variables')),/onboarding is incomplete/);
  assert.equal(f.calls.length,0);assert.equal(f.locks.length,0);
 }finally{await service.close();f.cleanup();}
});
test('changing target or plugin connection stops subsequent operations in an active transaction',async()=>{
 const f=fixture(),service=new McpFigmaOnboarding(f.runtime,f.config,{account:()=>null});try{
  service.select(`https://figma.com/design/${key}`,'new','plugin');
  await assert.rejects(service.transaction(async client=>{await client.call('first');service.select(`https://figma.com/design/${other}`,'existing','plugin');await client.call('second');}),/target or connection changed/);
  assert.deepEqual(f.calls.map(c=>c.method),['first']);
  service.select(`https://figma.com/design/${key}`,'new','plugin');
  await assert.rejects(service.transaction(async client=>{f.status.file.authorizationId='new-connection';await client.call('third');}),/connection changed/);
  assert.equal(f.calls.length,1);
 }finally{await service.close();f.cleanup();}
});
test('plugin approval requires the exact fresh selection, ticket and key, but no matching file name',async()=>{
 const f=fixture(),service=new McpFigmaOnboarding(f.runtime,f.config,{account:()=>null});try{
  f.status.file=null;f.pending({file:{key,name:'Untitled'},ticket,expiresAt:Date.now()+60_000});
  const chosen=service.select(`https://figma.com/design/${key}/Rift-system`,'new','plugin');
  const pending=await service.pending();assert.equal(pending.pending?.file.name,'Untitled');
  await assert.rejects(service.approve(chosen.target!.id,ticket,key,false),/Explicit approval/);
  await assert.rejects(service.approve(chosen.target!.id,'b'.repeat(64),key,true),/changed or expired/);
  const approved=await service.approve(chosen.target!.id,ticket,key,true);assert.equal(approved.ready,true);
  await assert.rejects(service.approve(chosen.target!.id,ticket,key,true),/changed or expired/);
  assert.equal(JSON.parse(readFileSync(f.config,'utf8')).figma.fileKey,other);
 }finally{await service.close();f.cleanup();}
});
test('account status redacts tokens; connecting returns only a hosted consent URL; close does not disconnect the account',async()=>{
 const f=fixture();let closeCalls=0;
 const account={accessToken:'never-return-access',refreshToken:'never-return-refresh',expiresAt:Date.now()+60000,origin:'https://connection.test'};
 const service=new McpFigmaOnboarding(f.runtime,f.config,{account:()=>account,createServer:async(_path,options)=>{
  assert.equal(options?.figmaConnectionOnly,true);
  return {fetch:async()=>Response.json({url:'https://connection.test/authorize?state=public-nonce',authorizationOrigin:'https://connection.test'}),close:async()=>{closeCalls++;}} as unknown as SettingsServerHandle;
 }});try{
  assert.doesNotMatch(JSON.stringify(service.status()),/never-return/);
  const result=await service.connect();assert.match(result.url,/^https:\/\/connection.test\//);assert.doesNotMatch(JSON.stringify(result),/never-return/);
 }finally{await service.close();assert.equal(closeCalls,1);f.cleanup();}
});

test('MCP callback mode is isolated, token-free and single-use; cross-process disconnect cancels pending exchange',async()=>{
 const f=fixture(),oldPath=process.env.ELF_FIGMA_ACCOUNT_PATH,oldFetch=globalThis.fetch;
 process.env.ELF_FIGMA_ACCOUNT_PATH=join(f.root,'account.json');
 const handles:SettingsServerHandle[]=[];
 let exchangeResolve:((response:Response)=>void)|null=null,exchangeStarted:(()=>void)|null=null;
 let defer=false,calls=0;
 globalThis.fetch=(async(input:any,init:any)=>{
  if(String(input).includes('/api/local-connect/figma/exchange')){calls++;if(defer){exchangeStarted?.();return new Promise<Response>(resolve=>exchangeResolve=resolve);}return Response.json({accessToken:'private-access-token',refreshToken:'private-refresh-token',expiresAt:Date.now()+3600_000});}
  return oldFetch(input,init);
 }) as typeof fetch;
 const service=new McpFigmaOnboarding(f.runtime,f.config,{createServer:async(path,options)=>{const server=await createSettingsServer(path,options);handles.push(server);return server;}});
 try{
  const flow=await service.connect(),url=new URL(flow.url),callback=new URL(url.searchParams.get('return_uri')!);
  assert.equal(callback.hostname,'127.0.0.1');
  assert.equal((await oldFetch(new URL('/api/config',callback))).status,404);
  assert.equal((await oldFetch(new URL('/api/figma/account',callback))).status,401);
  callback.search=new URLSearchParams({state:url.searchParams.get('state')!,grant:'f'.repeat(64)}).toString();
  const response=await oldFetch(callback);assert.equal(response.status,200);assert.match(await response.text(),/Return to your coding assistant/);
  assert.equal(readFigmaAccount()?.accessToken,'private-access-token');
  assert.equal((await oldFetch(callback)).status,400);assert.equal(calls,1);
  const next=await service.connect(),nextUrl=new URL(next.url),nextCallback=new URL(nextUrl.searchParams.get('return_uri')!);
  nextCallback.search=new URLSearchParams({state:nextUrl.searchParams.get('state')!,grant:'e'.repeat(64)}).toString();
  defer=true;const started=new Promise<void>(resolve=>exchangeStarted=resolve);const pending=oldFetch(nextCallback);await started;
  removeFigmaAccount();exchangeResolve!(Response.json({accessToken:'must-not-return',refreshToken:'must-not-return',expiresAt:Date.now()+3600_000}));
  assert.equal((await pending).status,400);assert.equal(readFigmaAccount(),null);
 }finally{await service.close();globalThis.fetch=oldFetch;if(oldPath===undefined)delete process.env.ELF_FIGMA_ACCOUNT_PATH;else process.env.ELF_FIGMA_ACCOUNT_PATH=oldPath;f.cleanup();}
});
