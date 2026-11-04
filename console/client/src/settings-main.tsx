import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { ApiProvider, useApi } from './lib/api-context';
import { ApiError, createApi } from './lib/api';
import { HostedReviewScreen, isHostedReview } from './screens/hosted-review';
import { Button } from '../../../settings-next/src/components/ui/button';
import { Card } from '../../../settings-next/src/components/ui/card';
import mascot from '../../../assets/brand/elf-mascot.png';
import '@fontsource-variable/inter/wght.css';
import '../../../settings-next/src/app/globals.css';

type Assistant={id:string;name:string;connected:boolean;connectedAt:number;lastUsedAt:number|null};
type AssistantList={assistants:Assistant[];cursor:string|null;connectorUrl:string};
function Files(){
  const api=useApi();
  const [files,setFiles]=React.useState<{id:string;fileKey:string;fileName:string|null;approved:boolean;connected:boolean}[]>([]);
  const [authorized,setAuthorized]=React.useState(false);
  React.useEffect(()=>{let active=true;const load=async()=>{try{const data=await api.get<{connections:typeof files}>('/hosted/connections');if(active){setFiles(data.connections);setAuthorized(true);}}catch(e){if(active&&e instanceof ApiError&&e.status===401){setFiles([]);setAuthorized(false);}}};void load();const timer=setInterval(load,10000);return()=>{active=false;clearInterval(timer);};},[api]);
  return <section className="mb-6" aria-labelledby="files-heading"><h2 id="files-heading" className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Figma files</h2>
    <p className="mb-3 text-xs text-muted-foreground">Approve each file in Elf Bridge. No Figma account sign-in is required.</p>
    {files.map(file=><Card key={file.id} className="mb-3 gap-1 border-[0.5px] p-3.5 shadow-none before:hidden"><a className="break-words underline" href={`?elf_connection=${file.id}`}>{file.fileName||'Untitled'}</a><p className="break-all text-xs text-muted-foreground">{file.fileKey}</p><p className="text-xs">{!file.connected?'Plugin offline':file.approved?'Approved · connected':'Waiting for approval in Elf Bridge'}</p></Card>)}
    <Button variant="outline" size="sm" disabled={!authorized} onClick={()=>location.assign('/settings?elf_add_file=')}>Add Figma file</Button>
    {!authorized&&<p className="mt-2 text-xs text-muted-foreground">Connect an assistant first, using this browser.</p>}
  </section>;
}
function Assistants() {
  const api=useApi();
  const [data,setData]=React.useState<AssistantList|null>(null),[error,setError]=React.useState(''),[busy,setBusy]=React.useState<string|null>(null);
  const load=React.useCallback(async()=>{
    try{setData(await api.get<AssistantList>('/hosted/assistants'));setError('');}
    catch(e){if(e instanceof ApiError&&e.status===401){setData({assistants:[],cursor:null,connectorUrl:location.origin+'/mcp'});setError('');}else setError(e instanceof Error?e.message:'Could not check MCP connections');}
  },[api]);
  React.useEffect(()=>{void load();const timer=setInterval(()=>{if(!document.hidden)void load();},10000);window.addEventListener('focus',load);return()=>{clearInterval(timer);window.removeEventListener('focus',load);};},[load]);
  const disconnect=async(assistant:Assistant)=>{
    setBusy(assistant.id);
    try{await api.post(`/hosted/assistants/${encodeURIComponent(assistant.id)}/disconnect`);await load();}
    catch(e){setError(e instanceof Error?e.message:'Could not disconnect');}
    finally{setBusy(null);}
  };
  return <section aria-labelledby="assistants-heading">
    <h2 id="assistants-heading" className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">MCP assistants</h2>
    {error&&<p role="alert" className="mb-3 text-xs text-destructive">{error}</p>}
    {!data&&!error&&<p role="status">Checking connections…</p>}
    {data&&<>
      {!data.assistants.length&&<Card className="mb-3 gap-1 border-[0.5px] p-3.5 shadow-none before:hidden"><p className="font-medium">Not connected</p><p className="text-xs text-muted-foreground">Add Elf in your assistant and approve access in Elf Bridge.</p></Card>}
      {data.assistants.map(assistant=><Card key={assistant.id} className="mb-3 gap-0 border-[0.5px] p-3.5 shadow-none before:hidden">
        <div className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1"><p className="break-words font-medium">{assistant.name}</p><p className="text-xs text-success" role="status">Connected</p></div><Button variant="destructive" size="sm" disabled={busy!==null} onClick={()=>void disconnect(assistant)}>Disconnect</Button></div>
        <p className="mt-2 text-xs text-muted-foreground">{assistant.lastUsedAt?`Last used ${new Date(assistant.lastUsedAt).toLocaleString()}`:'Authorized. Waiting for the first MCP request.'}</p>
      </Card>)}
      {data.cursor&&<Button variant="outline" size="sm" disabled={busy!==null} onClick={async()=>{setBusy('more');try{const more=await api.get<AssistantList>(`/hosted/assistants?cursor=${encodeURIComponent(data.cursor!)}`);setData({...more,assistants:[...data.assistants,...more.assistants]});}catch{setError('Could not load more assistants');}finally{setBusy(null);}}}>Show more</Button>}
      <details className="mt-4 text-xs text-muted-foreground"><summary className="cursor-pointer font-medium">Connect another assistant</summary><p className="mt-2">Use this URL in your assistant’s MCP connector settings, then approve the assistant in Elf Bridge.</p><code className="mt-2 block break-all rounded-lg border bg-card p-3">{data.connectorUrl}</code></details>
    </>}
  </section>;
}
function PluginAuthorization({addFile=false}:{addFile?:boolean}){
  const api=useApi();
  const query=new URLSearchParams(location.search).get('elf_authorize')!;
  const expectedOwner=new URLSearchParams(location.search).get('elf_assistant')||undefined;
  const [url,setUrl]=React.useState(addFile?new URLSearchParams(location.search).get('elf_add_file')||'':''),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false);
  const [pair,setPair]=React.useState<{handle:string;code:string;connectionId:string;fileKey:string;expiresAt:number;details:{clientName:string;redirectHost:string}}|null>(null);
  const [approved,setApproved]=React.useState(false);
  React.useEffect(()=>{
    if(!pair)return;
    let active=true;
    const check=async()=>{try{const c=await api.get<{connected:boolean;generation:string;approvedGeneration:string}>(`/hosted/connections/${pair.connectionId}`);if(active)setApproved(c.connected&&!!c.generation&&c.generation===c.approvedGeneration);}catch{if(active)setApproved(false);}};
    void check();const timer=setInterval(check,2000);return()=>{active=false;clearInterval(timer);};
  },[api,pair]);
  const act=async(work:()=>Promise<void>)=>{setBusy(true);setError('');try{await work();}catch(e){setError(e instanceof Error?e.message:'Connection failed');}finally{setBusy(false);}};
  return <Card className="mb-5 gap-3 border-[0.5px] p-4 shadow-none before:hidden">
    <h2 className="font-medium">{addFile?'Add a Figma file':'Connect your assistant'}</h2>
    <p className="text-xs text-muted-foreground">No Elf account or Figma account sign-in needed. Each file requires approval in Elf Bridge.</p>
    {error&&<p role="alert" className="text-xs text-destructive">{error}</p>}
    {!pair?<form className="flex flex-col gap-3" onSubmit={event=>{event.preventDefault();void act(async()=>{const next=await api.post<{owner?:string;handle:string;code:string;connectionId:string;fileKey:string;expiresAt:number;details:{clientName:string;redirectHost:string}}>(addFile?'/hosted/connections':'/hosted-auth/start',addFile?{url,expectedOwner}:{query,url});if(next.owner){const target=new URL(location.href);target.searchParams.set('elf_assistant',next.owner);history.replaceState(null,'',target);}setPair(next);});}}>
      <label className="text-xs" htmlFor="file-url">Figma file URL</label><input id="file-url" type="url" required value={url} onChange={e=>setUrl(e.target.value)} className="min-w-0 rounded-lg border bg-background px-3 py-2 text-sm" placeholder="https://www.figma.com/design/…"/>
      <Button disabled={busy} type="submit">{addFile?'Add file with Elf Bridge':'Continue with Elf Bridge'}</Button>
    </form>:<>
      <p className="text-sm"><strong>{pair.details.clientName}</strong> · returns to {pair.details.redirectHost}</p>
      <p className="text-xs text-muted-foreground">Assistant names are self-declared. Continue only if you started this request.</p>
      <p className="text-xs">Open this file in Figma, open Elf Bridge, select Hosted Elf, and paste this single-use code. Then approve the assistant in the plugin.</p>
      <code className="select-all rounded-lg border bg-background p-3 text-center text-lg tracking-wider">{pair.code}</code>
      <p className="break-all text-xs">File: {pair.fileKey}</p>
      <p className="text-xs text-muted-foreground">Code expires at {new Date(pair.expiresAt).toLocaleTimeString()}. Keep this browser tab for Settings and future change reviews.</p>
      <p role="status" className="text-xs">{approved?'Approved in Elf Bridge. Ready to return to your assistant.':'Waiting for approval in Elf Bridge…'}</p>
      {addFile?<><p className="text-xs">Existing file approvals stay unchanged. Ask your assistant to check figma_onboarding_status and select this file’s connection ID.</p><Button variant="outline" disabled={busy} onClick={()=>void act(async()=>{await api.post(`/hosted/connections/${pair.connectionId}/disconnect`);location.assign('/settings');})}>Remove this file connection</Button></>:<>
        <Button disabled={busy||!approved} onClick={()=>void act(async()=>{const result=await api.post<{redirectTo:string}>('/hosted/consent/finish',{handle:pair.handle,approve:true});location.assign(result.redirectTo);})}>Finish connection</Button>
        <Button variant="outline" disabled={busy} onClick={()=>void act(async()=>{const result=await api.post<{redirectTo:string}>('/hosted/consent/finish',{handle:pair.handle,approve:false});location.assign(result.redirectTo);})}>Cancel</Button>
      </>}
    </>}
  </Card>;
}
function Settings() {
  const api=React.useMemo(()=>createApi(async()=>null,()=>new URLSearchParams(location.search).get('elf_assistant')),[]);
  const authorize=new URLSearchParams(location.search).has('elf_authorize');
  const addFile=new URLSearchParams(location.search).has('elf_add_file');
  return <ApiProvider client={api}><main className="mx-auto w-full min-w-0 max-w-[420px] px-5 pb-8 pt-8 [overflow-wrap:anywhere]">
    <header className="mb-6 flex items-center gap-3"><img src={mascot} width={32} height={32} alt=""/><div><p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Elf</p><h1 className="text-[15px] font-medium">Settings</h1></div></header>
    {authorize?<PluginAuthorization/>:addFile?<PluginAuthorization addFile/>:<>{isHostedReview()&&<HostedReviewScreen embedded/>}<Files/><Assistants/></>}
    <footer className="mt-6 text-center text-[11px] text-faint">Elf · your design system, connected<a className="mt-3 block underline underline-offset-4" href="/downloads/elf-bridge-hosted.zip" download>Download Elf Bridge for Figma Desktop</a></footer>
  </main></ApiProvider>;
}
document.documentElement.style.setProperty('--font-inter','"Inter Variable"');
document.documentElement.classList.toggle('dark',matchMedia('(prefers-color-scheme: dark)').matches);
createRoot(document.getElementById('root')!).render(<Settings/>);
