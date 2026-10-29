import * as React from 'react';
import { useApi } from '@/lib/api-context';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

interface ConnectionReview {id:string;fileKey:string;fileName:string;generation:string|null;approvedGeneration:string|null;connected:boolean;}
interface PlanReview {id:string;fileKey:string;fileName:string;generation:string;hash:string;operations:{method:string;params:Record<string,unknown>}[];state:string;expires:number;sourceHash:string|null;}
interface ConsentReview {handle:string;details:{clientName:string;clientDomain:string|null;redirectHost:string;redirectIsLoopback:boolean;scope:string[]};}

export function isHostedReview() {
  const query=new URLSearchParams(location.search);
  return ['elf_authorize','elf_connection','elf_plan'].some(key=>query.has(key));
}

export function HostedReviewScreen() {
  const api=useApi(),query=React.useMemo(()=>new URLSearchParams(location.search),[]);
  const [connection,setConnection]=React.useState<ConnectionReview|null>(null);
  const [plan,setPlan]=React.useState<PlanReview|null>(null);
  const [consent,setConsent]=React.useState<ConsentReview|null>(null);
  const [error,setError]=React.useState(''),[message,setMessage]=React.useState(''),[busy,setBusy]=React.useState(false);
  const connectionId=query.get('elf_connection'),planId=query.get('elf_plan'),authorize=query.get('elf_authorize');
  React.useEffect(()=>{
    let active=true;
    (async()=>{
      try{
        if(authorize){const data=await api.post<ConsentReview>('/hosted/consent/start',{query:authorize});if(active)setConsent(data);}
        else if(connectionId){const data=await api.get<ConnectionReview>(`/hosted/connections/${encodeURIComponent(connectionId)}`);if(active)setConnection(data);}
        else if(planId){const data=await api.get<PlanReview>(`/hosted/plans/${encodeURIComponent(planId)}`);if(active)setPlan(data);}
      }catch(e){if(active)setError(e instanceof Error?e.message:'Could not load review');}
    })();return()=>{active=false;};
  },[api,authorize,connectionId,planId]);
  const act=async(work:()=>Promise<void>)=>{setBusy(true);setError('');try{await work();}catch(e){setError(e instanceof Error?e.message:'Action failed');}finally{setBusy(false);}};
  const finishConsent=async(approve:boolean)=>{
    const result=await api.post<{redirectTo:string}>('/hosted/consent/finish',{handle:consent!.handle,approve});
    // The server validates the registered exact redirect URI before returning this URL.
    location.assign(result.redirectTo);
  };
  return <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center gap-5 px-5 py-10">
    <a className="w-fit font-heading text-lg font-semibold" href="/">elf</a>
    <Card className="gap-5 overflow-hidden p-6">
      <header><h1 className="font-heading text-xl font-semibold">{authorize?'Connect your assistant':planId?'Review Figma changes':'Approve this Figma connection'}</h1>
        <p className="mt-2 text-sm text-muted-foreground">Review access and changes before continuing.</p></header>
      {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
      {message&&<p role="status" className="text-sm">{message}</p>}
      {!error&&!connection&&!plan&&!consent&&<p role="status">Loading review…</p>}
      {consent&&<>
        <p><strong>{consent.details.clientName}</strong> wants to use Elf on your behalf.</p>
        <p className="text-sm text-muted-foreground">{consent.details.clientDomain?`Published by ${consent.details.clientDomain}.`:'This app registered itself. Its name is not verified.'} Access will be returned to <strong>{consent.details.redirectHost}</strong>.</p>
        {consent.details.redirectIsLoopback&&<p className="text-sm">This connects an app on your computer. Continue only if you started this connection.</p>}
        <ul className="list-disc space-y-1 pl-5 text-sm">{consent.details.scope.map(scope=><li key={scope}>{scope==='elf:read'?'Read paired Figma resources and prepare Markdown reviews':scope==='elf:write'?'Request changes, with separate approval for each plan':scope==='offline_access'?'Keep this assistant connected until access expires or is revoked':scope}</li>)}</ul>
        <div className="flex flex-wrap gap-3"><Button disabled={busy} onClick={()=>act(()=>finishConsent(true))}>Allow connection</Button><Button variant="outline" disabled={busy} onClick={()=>act(()=>finishConsent(false))}>Deny</Button></div>
      </>}
      {connection&&<>
        <p className="font-medium">{connection.fileName||'Untitled'}</p><p className="break-all font-mono text-xs">{connection.fileKey}</p>
        <p className="text-sm">Plugin-only trust: Elf trusts the document reported by the open plugin. It is not independently verified through Figma REST. Confirm that this is the file you intend to use.</p>
        <p className="text-sm text-muted-foreground">{connection.connected?'Plugin connected.':'Plugin offline. Reopen it and refresh this page.'} Approving a connection does not approve resource changes.</p>
        <div className="flex flex-wrap gap-3"><Button disabled={busy||!connection.connected||!connection.generation||!!message} onClick={()=>act(async()=>{await api.post(`/hosted/connections/${connection.id}/approve`,{generation:connection.generation,fileKey:connection.fileKey,trust:'plugin'});setMessage('Connection approved. Return to your assistant.');})}>Approve this document</Button>
        <Button variant="destructive" disabled={busy} onClick={()=>act(async()=>{await api.post(`/hosted/connections/${connection.id}/disconnect`);setConnection(null);setMessage('Disconnected. Saved plugin access is revoked.');})}>Disconnect</Button></div>
      </>}
      {plan&&<>
        <p><strong>{plan.fileName||'Untitled'}</strong></p><p className="break-all font-mono text-xs">{plan.fileKey}</p>
        <p className="text-sm">{plan.operations.length} operations · {plan.state} · expires {new Date(plan.expires).toLocaleTimeString()}</p>
        <p className="text-sm text-muted-foreground">Review every operation, including updates to existing resources. Applying can partially succeed; there is no automatic rollback.</p>
        <div className="max-h-96 space-y-3 overflow-auto rounded-lg border p-3">{plan.operations.map((op,i)=><details key={i}><summary className="cursor-pointer text-sm font-medium">{i+1}. {op.method} · {String(op.params.name??op.params.collection??'Figma resource')}</summary><pre className="mt-2 whitespace-pre-wrap break-all text-xs">{JSON.stringify(op.params,null,2)}</pre></details>)}</div>
        <Button disabled={busy||plan.state!=='review'||plan.expires<Date.now()||!!message} onClick={()=>act(async()=>{await api.post(`/hosted/plans/${plan.id}/approve`,{hash:plan.hash,generation:plan.generation});setMessage('Plan approved. Return to your assistant to apply these exact changes.');})}>Approve these changes</Button>
      </>}
    </Card>
  </main>;
}
