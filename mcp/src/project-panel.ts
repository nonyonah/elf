import type WebSocket from 'ws';
type Scope={socket:WebSocket|null;identity:string;fileKey?:string};
/** Plugin requests can select an already registered project, never a filesystem path. */
export class ProjectPanelRelay {
 private owners=new Map<string,{fileKey:string;label:string;until:number}>();
 private pending=new Map<string,{owner:string;socket:WebSocket;identity:string;action:string;params:Record<string,unknown>;until:number;delivered:boolean}>();
 constructor(private send:(socket:WebSocket,message:unknown)=>void){}
 private prune():void {
  for(const [id,owner] of this.owners) if(owner.until<Date.now()) this.owners.delete(id);
  for(const [id,request] of this.pending) if(request.until<Date.now()||!this.owners.has(request.owner)) {this.send(request.socket,{type:'project-result',id,ok:false,error:'The local project stopped responding. Refresh and review again.'});this.pending.delete(id);}
 }
 plugin(message:any,scope:Scope):void {
  this.prune();
  const id=message.id;
  if(typeof id!=='string'||!/^[-a-zA-Z0-9]{1,64}$/.test(id)||!scope.socket)return;
  const fail=(error:string)=>this.send(scope.socket!,{type:'project-result',id,ok:false,error});
  if(!scope.fileKey){fail('Approve and connect this Figma document first.');return;}
  if(message.action==='projects'){this.send(scope.socket,{type:'project-result',id,ok:true,result:{projects:[...this.owners].filter(([,owner])=>owner.fileKey===scope.fileKey).map(([key,owner])=>({id:key,label:owner.label}))}});return;}
  if(this.pending.has(id)){fail('This request is already in progress.');return;}
  const owner=this.owners.get(message.owner);
  if(!owner||owner.fileKey!==scope.fileKey){fail('Start Elf for this project in your editor or with elf start, then refresh.');return;}
  if(!['list','plan','apply'].includes(message.action)){fail('Unsupported project operation.');return;}
  if(this.pending.size>=20||[...this.pending.values()].some(request=>request.owner===message.owner)){fail('This project already has an operation in progress.');return;}
  const params:any={};
  if(message.action==='plan'&&message.params?.selection){const selection=message.params.selection;if(!['token','component','style'].includes(selection.kind)||typeof selection.key!=='string'||selection.key.length>500){fail('Select one listed resource.');return;}params.selection={kind:selection.kind,key:selection.key};}
  if(message.action==='apply'){if(typeof message.params?.planId!=='string'||message.params.planId.length>100){fail('Review a sync plan first.');return;}params.planId=message.params.planId;params.overwriteConflicts=message.params.overwriteConflicts===true;}
  this.pending.set(id,{owner:message.owner,socket:scope.socket,identity:scope.identity,action:message.action,params,until:Date.now()+120000,delivered:false});
 }
 control(method:string,params:any,scope:Scope):unknown {
  this.prune();
  if(typeof params.owner!=='string'||!/^[a-f0-9]{64}$/.test(params.owner))throw new Error('Invalid project registration.');
  if(method==='__elf_project_poll'){
   if(typeof params.fileKey!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(params.fileKey)||typeof params.label!=='string'||params.label.length>100)throw new Error('Invalid project registration.');
   if(!this.owners.has(params.owner)&&this.owners.size>=20)throw new Error('Too many local projects.');
   this.owners.set(params.owner,{fileKey:params.fileKey,label:params.label,until:Date.now()+15000});
   if(params.accept===false)return null;
   for(const [id,request]of this.pending)if(request.owner===params.owner&&!request.delivered){request.delivered=true;return{id,action:request.action,params:request.params};}
   return null;
  }
  if(method==='__elf_project_unregister'){this.owners.delete(params.owner);this.prune();return{ok:true};}
  if(method!=='__elf_project_reply')throw new Error('Unsupported project control.');
  const request=this.pending.get(params.id);
  if(!request||request.owner!==params.owner)throw new Error('This project request expired.');
  this.pending.delete(params.id);
  if(request.socket!==scope.socket||request.identity!==scope.identity)throw new Error('The Figma document connection changed.');
  const response={type:'project-result',id:params.id,ok:params.ok===true,...(params.ok===true?{result:params.result}:{error:typeof params.error==='string'?params.error.slice(0,1000):'Project operation failed.'})};
  if(Buffer.byteLength(JSON.stringify(response))>256000){this.send(request.socket,{type:'project-result',id:params.id,ok:false,error:'This result is too large. Review individual resources in the Elf editor.'});return{ok:true};}
  this.send(request.socket,response);return{ok:true};
 }
}
