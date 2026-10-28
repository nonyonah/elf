import {randomBytes} from 'node:crypto';
import {dirname} from 'node:path';
import {readSource} from './discovery.js';
import type {BridgeRuntime} from '../mcp/src/runtime.js';
import type {ProjectService} from './project.js';
/** Heartbeat and bounded mailbox keep filesystem access in the trusted local adapter. */
export async function startPluginProject(project:ProjectService,runtime:BridgeRuntime):Promise<()=>Promise<void>>{
 const capabilities=await runtime.control<{projectPanel?:number}>('__elf_capabilities');
 if(capabilities.projectPanel!==1)return async()=>{};
 const owner=randomBytes(32).toString('hex');let stopped=false,polling=false,working=false;
 const tick=async()=>{
  if(stopped||polling)return;polling=true;
  try{
   const raw=JSON.parse(readSource(project.configPath));if(!raw.figma?.fileKey)return;
   const request=await runtime.control<any>('__elf_project_poll',{owner,fileKey:raw.figma.fileKey,label:dirname(project.configPath).slice(-100),accept:!working});
   if(!request||working)return;working=true;
   void(async()=>{
    try{
     let result:unknown;
     if(request.action==='list'){const plan=await project.plan();result={entries:plan.entries,issues:plan.issues};}
     else if(request.action==='plan')result=await project.plan(request.params.selection);
     else if(request.action==='apply')result=await project.apply(request.params.planId,{overwriteConflicts:request.params.overwriteConflicts===true});
     else throw new Error('Unsupported plugin project action.');
     await runtime.control('__elf_project_reply',{owner,id:request.id,ok:true,result});
    }catch(error){try{await runtime.control('__elf_project_reply',{owner,id:request.id,ok:false,error:(error as Error).message});}catch{}}
    finally{working=false;}
   })();
  }catch{}finally{polling=false;}
 };
 const timer=setInterval(()=>{void tick();},1000);timer.unref();void tick();
 return async()=>{stopped=true;clearInterval(timer);try{await runtime.control('__elf_project_unregister',{owner});}catch{}};
}
