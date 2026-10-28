import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bridge } from '../src/bridge.js';
import { BridgeClient } from '../src/client.js';
import { FakePlugin, waitFor } from './helpers/plugin-connection.js';
import { acquireBridge } from '../src/runtime.js';
import { ProjectService } from '../../src/project.js';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('plugin-only operations require fresh approval, explicit policy, and never call REST', async () => {
  const token = 'document-approval-test-token'; let reads = 0;
  const bridge = new Bridge({token,port:0,verifyPublicFile:async()=>{reads++;throw new Error('REST must not be called');}});
  const port = await bridge.start();
  const client = await BridgeClient.connect({port,token});
  let plugin = await FakePlugin.connect({port,token,handlers:{list_variables:()=>({variables:[]})}});
  const status = {type:'status' as const,file:{key:'approvedFile',name:'Open file',verification:{nonce:'a'.repeat(64),method:'plugin' as const}}};
  try {
    plugin.send(status);
    await waitFor(()=>Boolean(bridge.status.pendingApproval));
    const pending = await client.call<any>('__elf_document_pending');
    assert.equal(bridge.status.file,null);
    await assert.rejects(client.call('list_variables'),/explicit approval/);
    await assert.rejects(client.call('__elf_document_approve',{fileKey:'differentFile',ticket:pending.ticket}),/changed/);
    await client.call('__elf_document_approve',{fileKey:'approvedFile',ticket:pending.ticket});
    assert.equal((bridge.status as import('../src/bridge.js').BridgeStatus).file?.authorization,'plugin');
    await assert.rejects(client.transaction('approvedFile',async()=>{}),/strict file verification/);
    await client.transaction('approvedFile',async c=>{assert.deepEqual(await c.call('list_variables'),{variables:[]});},{authorization:'plugin'});
    plugin.terminate(); await waitFor(()=>!bridge.status.connected);
    plugin = await FakePlugin.connect({port,token}); plugin.send(status);
    await waitFor(()=>Boolean(bridge.status.pendingApproval));
    assert.equal(bridge.status.file,null);
    await assert.rejects(client.call('__elf_document_approve',{fileKey:'approvedFile',ticket:pending.ticket}),/changed/);
    const next = await client.call<any>('__elf_document_pending');
    assert.notEqual(next.ticket,pending.ticket);
    (bridge as any).documentApproval.expiresAt=Date.now()-1;
    await assert.rejects(client.call('__elf_document_approve',{fileKey:'approvedFile',ticket:next.ticket}),/expired/);
    assert.equal(reads,0);
  } finally {plugin.terminate();await client.close();await bridge.stop();}
});

test('managed project approval works with an owned bridge and retains reviewed sync planning', async () => {
  const root = mkdtempSync(join(tmpdir(),'elf-approved-project-')); const config = join(root,'elf.config.json');
  const token = 'owned-document-approval-token';
  writeFileSync(join(root,'tokens.css'),':root { --color-primary: #112233; }');
  writeFileSync(config,JSON.stringify({figma:{fileKey:'ownedFile123',source:'bridge'},codebase:{path:'tokens.css',source:'css'}}));
  const runtime = await acquireBridge({token,port:0,timeoutMs:1000});
  const plugin = await FakePlugin.connect({port:runtime.connection.status.port!,token,handlers:{list_collections:()=>({collections:[]}),list_variables:()=>({variables:[]}),list_components:()=>({components:[]}),list_styles:()=>({styles:[]})}});
  try {
    plugin.send({type:'status',file:{key:'ownedFile123',name:'Approved document',verification:{nonce:'c'.repeat(64),method:'plugin'}}});
    await waitFor(()=>Boolean(runtime.connection.status.pendingApproval));
    const project = new ProjectService(config,runtime);
    const pending = await project.pendingDocument() as {ticket:string};
    await project.approveDocument('ownedFile123',pending.ticket,true);
    const plan = await project.plan();
    assert.equal(plan.entries[0].kind,'token');
    assert.equal(project.automatic(),false);
    assert.equal(JSON.parse(readFileSync(config,'utf8')).figma.authorization,'plugin');
    const output = join(root,'drift-report.md');
    await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../../bin/elf-tokens.js',import.meta.url)),'check','--config',config,'--out',output],{cwd:root,env:{...process.env,ELF_MCP_TOKEN:token,ELF_MCP_PORT:String(runtime.connection.status.port),FIGMA_API_TOKEN:'',ELF_FIGMA_ACCOUNT_PATH:join(root,'no-account.json')},timeout:15000});
    assert.match(readFileSync(output,'utf8'),/Missing in Figma/);
  } finally {plugin.terminate();await runtime.close();rmSync(root,{recursive:true,force:true});}
});
