import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {loadConfig} from './config.js';
import {readFigmaAccount} from './figma/account.js';
import {createSettingsServer,type SettingsServerHandle} from './settings.js';
import type {BridgeRuntime} from '../mcp/src/runtime.js';
import type {BridgeClient,PluginConnection} from '../mcp/src/client.js';

type Authorization='strict'|'plugin';
interface Target {id:string;fileKey:string;url:string;purpose:'new'|'existing';authorization:Authorization;}
interface Dependencies {
  account?:typeof readFigmaAccount;
  createServer?:typeof createSettingsServer;
}
export function parseFigmaFileUrl(input:string):{fileKey:string;url:string}{
  if(typeof input!=='string'||input.length>2048)throw new Error('Provide an HTTPS Figma design-file URL.');
  let url:URL;try{url=new URL(input);}catch{throw new Error('Provide an HTTPS Figma design-file URL.');}
  const match=/^\/(?:design|file)\/([A-Za-z0-9_-]{8,128})(?:\/|$)/.exec(url.pathname);
  if(url.protocol!=='https:'||!['figma.com','www.figma.com'].includes(url.hostname)||url.port||url.username||url.password||!match)throw new Error('Provide an HTTPS figma.com/design/… or figma.com/file/… URL.');
  return {fileKey:match[1],url:`https://www.figma.com/design/${match[1]}`};
}

/** Local stdio onboarding. Target choice never rewrites drift configuration. */
export class McpFigmaOnboarding {
  private selected:Target|null=null;
  private callbackServer:Promise<SettingsServerHandle>|null=null;
  private closed=false;
  private account:typeof readFigmaAccount;
  constructor(private runtime:BridgeRuntime,private configPath:string|null,private dependencies:Dependencies={}){this.account=dependencies.account??readFigmaAccount;}
  private configured(){
    if(!this.configPath||!existsSync(this.configPath))return null;
    const config=loadConfig(this.configPath);return {fileKey:config.figma.fileKey,authorization:config.figma.authorization??'strict' as Authorization};
  }
  private target(){const configured=this.configured();return this.selected??(configured?{id:`project:${configured.fileKey}:${configured.authorization}`,fileKey:configured.fileKey,authorization:configured.authorization,url:`https://www.figma.com/design/${configured.fileKey}`,purpose:'existing' as const}:null);}
  status(){
    const target=this.target(),bridge=this.runtime.connection.status,account=this.account();
    const matching=Boolean(target&&bridge.file?.key===target.fileKey);
    const strictSatisfied=target?.authorization!=='strict'||bridge.file?.authorization!=='plugin';
    const requiresAccount=Boolean(this.selected&&target?.authorization==='strict'&&!account);
    const ready=Boolean(!this.closed&&target&&bridge.connected&&matching&&strictSatisfied&&!requiresAccount&&!bridge.pendingApproval);
    const nextAction=this.closed?'restart_mcp':!target?'select_figma_file':requiresAccount?'connect_figma_account':!bridge.connected?'get_figma_pairing_code':bridge.pendingApproval&&bridge.pendingApproval.key!==target.fileKey?'open_selected_file_and_plugin':bridge.pendingApproval?target.authorization==='plugin'?'approve_figma_target':'choose_strict_verification_in_plugin':!matching?'open_selected_file_and_plugin':!strictSatisfied?'choose_strict_verification_in_plugin':'inspect_selected_file';
    return {account:{connected:Boolean(account),expiresAt:account?.expiresAt??null},target:target?{...target,selection:this.selected?'mcp-session':'configured-project'}:null,projectFileKey:this.configured()?.fileKey??null,bridge:{connected:bridge.connected,file:bridge.file?{key:bridge.file.key,name:bridge.file.name,authorization:bridge.file.authorization??'strict'}:null,pendingApproval:bridge.pendingApproval??null},ready,nextAction,
      note:'File names are labels. The selected file key must match the approved bridge document. MCP target selection does not change project drift monitoring.'};
  }
  select(url:string,purpose:'new'|'existing',authorization:Authorization){
    if(this.closed)throw new Error('This MCP session has closed.');
    if(!['new','existing'].includes(purpose)||!['strict','plugin'].includes(authorization))throw new Error('Choose a new/existing target and strict/plugin authorization explicitly.');
    this.selected={id:randomUUID(),...parseFigmaFileUrl(url),purpose,authorization};
    return this.status();
  }
  async connect(){
    if(this.closed)throw new Error('This MCP session has closed.');
    // This server exposes account connection only, not project settings/actions.
    if(!this.callbackServer)this.callbackServer=(this.dependencies.createServer??createSettingsServer)(this.configPath??'',{figmaConnectionOnly:true,port:0}).catch(error=>{this.callbackServer=null;throw error;});
    const server=await this.callbackServer;
    if(this.closed)throw new Error('This MCP session has closed.');
    const response=await server.fetch('/api/figma/connect',{method:'POST',headers:{'X-Elf-Request':'1'}});
    if(!response.ok)throw new Error('Figma sign-in could not start. Retry connect_figma_account.');
    const data=await response.json();const url=new URL(data.url);
    if(url.protocol!=='https:'||url.origin!==data.authorizationOrigin)throw new Error('Unexpected Figma authorization address.');
    return {url:url.href,authorizationOrigin:url.origin,expiresInSeconds:600,instructions:'Open this link to sign in to Figma. Complete consent in the browser, then call figma_onboarding_status. No credentials are returned to the assistant.'};
  }
  async pairing(){
    if(this.closed)throw new Error('This MCP session has closed.');
    if(!this.target())throw new Error('Select the intended Figma file URL first.');
    const pairing=await this.runtime.refreshPairingCode();
    return {pairing:{code:pairing.code,expiresAt:pairing.expiresAt},target:this.target(),instructions:'Open this Figma file and Elf Bridge. Enter the selected file link and choose the matching verification mode, then paste this single-use code. Saved pairings may reconnect without a code.'};
  }
  async approve(selectionId:string,ticket:string,fileKey:string,approved:boolean){
    if(this.closed)throw new Error('This MCP session has closed.');
    const target=this.selected;
    if(!approved||!target||target.id!==selectionId||target.fileKey!==fileKey||target.authorization!=='plugin')throw new Error('Explicit approval of the selected plugin-only target is required.');
    const pending=await this.runtime.control<{file:{key:string;name:string};ticket:string;expiresAt:number}|null>('__elf_document_pending');
    if(this.selected!==target||!pending||pending.file.key!==fileKey||pending.ticket!==ticket||pending.expiresAt<=Date.now())throw new Error('Pending document changed or expired. Inspect it and review again.');
    await this.runtime.control('__elf_document_approve',{fileKey,ticket});
    if(this.selected!==target)throw new Error('Target changed during approval. Review the current target.');
    return this.status();
  }
  async pending(){
    if(this.closed)throw new Error('This MCP session has closed.');
    const target=this.selected;if(!target)throw new Error('Select the Figma target first.');
    const pending=await this.runtime.control<{file:{key:string;name:string};ticket:string;expiresAt:number}|null>('__elf_document_pending');
    if(this.selected!==target)throw new Error('Target changed. Inspect it again.');
    if(pending&&pending.file.key!==target.fileKey)throw new Error('The open document differs from the selected file key. Open the selected file before approval.');
    return {selectionId:target.id,target,pending};
  }
  async transaction<T>(work:(client:BridgeClient)=>Promise<T>):Promise<T>{
    const target=this.target(),state=this.status();
    if(this.closed||!target||!state.ready)throw new Error(`Figma onboarding is incomplete. Next step: ${state.nextAction}.`);
    const context=this.runtime.connection.status;
    const identity=`${context.connectedAt}:${context.file?.authorizationId??''}`;
    const check=()=>{const current=this.runtime.connection.status;if(this.closed||this.target()?.id!==target.id||`${current.connectedAt}:${current.file?.authorizationId??''}`!==identity)throw new Error('The Figma target or connection changed during this operation. Review completed changes before retrying.');};
    return this.runtime.transaction(target.fileKey,async client=>{
      check();
      const guarded=new Proxy(client,{get:(object,property)=>{
        if(property==='call'||property==='request')return async(...args:unknown[])=>{check();const result=await (object[property] as (...args:unknown[])=>Promise<unknown>).apply(object,args);check();return result;};
        const value=Reflect.get(object,property);return typeof value==='function'?value.bind(object):value;
      }});
      return work(guarded);
    },{authorization:target.authorization});
  }
  connection():PluginConnection{
    const onboarding=this;return {get status(){return onboarding.runtime.connection.status;},get isConnected(){return onboarding.runtime.connection.isConnected;},onStatus:listener=>onboarding.runtime.connection.onStatus(listener),request:async<T>(method:string,params:Record<string,unknown>={},options?:{timeoutMs?:number})=>onboarding.transaction(client=>client.call<T>(method,params,options))};
  }
  async close(){this.closed=true;this.selected=null;await this.callbackServer?.then(server=>server.close()).catch(()=>{});this.callbackServer=null;}
}
