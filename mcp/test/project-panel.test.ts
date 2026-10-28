import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ProjectPanelRelay} from '../src/project-panel.js';
const owner='a'.repeat(64),other='b'.repeat(64);
function setup(){const sent:any[]=[];const socket={} as any;const scope={socket,identity:'connection-1',fileKey:'file-123456'};const relay=new ProjectPanelRelay((_socket,message)=>sent.push(message));return{sent,scope,relay};}
test('plugin project operations expose only matching registered projects and never accept filesystem paths or automatic sync',()=>{
 const {relay,scope,sent}=setup();
 relay.control('__elf_project_poll',{owner,fileKey:scope.fileKey,label:'Project A'},scope);
 relay.control('__elf_project_poll',{owner:other,fileKey:'other-file',label:'Project B'},scope);
 relay.plugin({id:'projects',action:'projects'},scope);
 assert.deepEqual(sent.pop().result.projects,[{id:owner,label:'Project A'}]);
 relay.plugin({id:'bad',action:'list',owner:other},scope);assert.equal(sent.pop().ok,false);
 relay.plugin({id:'pending',action:'list',owner},{...scope,fileKey:undefined});assert.equal(sent.pop().ok,false);
 relay.plugin({id:'apply',action:'apply',owner,params:{planId:'reviewed',enableAuto:true,path:'/etc/passwd'}},scope);
 const request:any=relay.control('__elf_project_poll',{owner,fileKey:scope.fileKey,label:'Project A'},scope);
 assert.deepEqual(request.params,{planId:'reviewed',overwriteConflicts:false});
 assert.equal(relay.control('__elf_project_poll',{owner,fileKey:scope.fileKey,label:'Project A'},scope),null);
 assert.throws(()=>relay.control('__elf_project_reply',{owner:other,id:'apply',ok:true},scope),/expired/);
 relay.control('__elf_project_reply',{owner,id:'apply',ok:true,result:{synced:1}},scope);
 assert.equal(sent.pop().result.synced,1);
});
test('plugin project replies reject changed documents, replay, and invalid selection',()=>{
 const {relay,scope,sent}=setup();relay.control('__elf_project_poll',{owner,fileKey:scope.fileKey,label:'A'},scope);
 relay.plugin({id:'bad',owner,action:'plan',params:{selection:{kind:'shell',key:'run'}}},scope);assert.equal(sent.pop().ok,false);
 relay.plugin({id:'one',owner,action:'plan',params:{selection:{kind:'token',key:'color-brand'}}},scope);
 assert.equal(relay.control('__elf_project_poll',{owner,fileKey:scope.fileKey,label:'A',accept:false},scope),null);
 const request:any=relay.control('__elf_project_poll',{owner,fileKey:scope.fileKey,label:'A'},scope);assert.equal(request.params.selection.key,'color-brand');
 assert.throws(()=>relay.control('__elf_project_reply',{owner,id:'one',ok:true,result:{}},{...scope,identity:'new-connection'}),/changed/);
 assert.throws(()=>relay.control('__elf_project_reply',{owner,id:'one',ok:true,result:{}},scope),/expired/);
});


test('plugin requests round-trip through an authenticated bridge and the registered local project',async()=>{
 const {acquireBridge}=await import('../src/runtime.js');const {FakePlugin,waitFor}=await import('./helpers/plugin-connection.js');
 const {startPluginProject}=await import('../../src/plugin-project.js');const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const root=mkdtempSync(join(tmpdir(),'elf-plugin-project-'));const path=join(root,'elf.config.json');writeFileSync(path,JSON.stringify({figma:{fileKey:'pluginFile123'}}));
 const token='plugin-project-test-token';const runtime=await acquireBridge({token,port:0,timeoutMs:3000});const plugin=await FakePlugin.connect({port:runtime.connection.status.port!,token});let stop=async()=>{};let applied=0;
 const socket=(plugin as any).socket;const replies=new Map<string,any>();socket.on('message',(data:any)=>{const message=JSON.parse(data.toString());if(message.type==='project-result')replies.set(message.id,message);});
 const request=async(id:string,action:string,owner?:string,params?:unknown)=>{plugin.send({type:'project-operation',id,action,owner,params} as any);await waitFor(()=>replies.has(id));return replies.get(id);};
 try{
  plugin.sendStatus({key:'pluginFile123',name:'File'});await waitFor(()=>Boolean(runtime.connection.status.file));
  const service={configPath:path,plan:async(selection:any)=>({id:'review-plan',entries:[{kind:'token',key:'color-brand',name:'color-brand',action:'create'}],issues:[],selection}),apply:async(id:string)=>{assert.equal(id,'review-plan');applied++;return{synced:1};}};
  stop=await startPluginProject(service as any,runtime);
  let projects:any[]=[];for(let count=0;count<20&&!projects.length;count++){projects=(await request(`projects-${count}`,'projects')).result.projects;if(!projects.length)await new Promise(resolve=>setTimeout(resolve,50));}
  assert.equal(projects.length,1);
  const listed=await request('list','list',projects[0].id);assert.equal(listed.result.entries[0].action,'create');assert.equal(applied,0);
  const plan=await request('plan','plan',projects[0].id,{selection:{kind:'token',key:'color-brand'}});assert.equal(plan.result.selection.key,'color-brand');assert.equal(applied,0);
  const result=await request('apply','apply',projects[0].id,{planId:plan.result.id});assert.equal(result.result.synced,1);assert.equal(applied,1);
 }finally{await stop();plugin.terminate();await runtime.close();rmSync(root,{recursive:true,force:true});}
});
