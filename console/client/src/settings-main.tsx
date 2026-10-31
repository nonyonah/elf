import { ClerkProvider, SignIn, UserButton, useAuth } from '@clerk/react';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { ApiProvider, useApi } from './lib/api-context';
import { createApi } from './lib/api';
import { HostedReviewScreen, isHostedReview } from './screens/hosted-review';
import { Button } from '../../../settings-next/src/components/ui/button';
import { Card } from '../../../settings-next/src/components/ui/card';
import mascot from '../../../assets/brand/elf-mascot.png';
import '@fontsource-variable/inter/wght.css';
import '../../../settings-next/src/app/globals.css';

type Assistant={id:string;name:string;connected:boolean;connectedAt:number;lastUsedAt:number|null};
type AssistantList={assistants:Assistant[];cursor:string|null;connectorUrl:string};
function Assistants() {
  const api=useApi();
  const [data,setData]=React.useState<AssistantList|null>(null),[error,setError]=React.useState(''),[busy,setBusy]=React.useState<string|null>(null);
  const load=React.useCallback(async()=>{
    try{setData(await api.get<AssistantList>('/hosted/assistants'));setError('');}
    catch(e){setError(e instanceof Error?e.message:'Could not check MCP connections');}
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
      {!data.assistants.length&&<Card className="mb-3 gap-1 border-[0.5px] p-3.5 shadow-none before:hidden"><p className="font-medium">Not connected</p><p className="text-xs text-muted-foreground">Add Elf in your assistant and approve access here.</p></Card>}
      {data.assistants.map(assistant=><Card key={assistant.id} className="mb-3 gap-0 border-[0.5px] p-3.5 shadow-none before:hidden">
        <div className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1"><p className="break-words font-medium">{assistant.name}</p><p className="text-xs text-success" role="status">Connected</p></div><Button variant="destructive" size="sm" disabled={busy!==null} onClick={()=>void disconnect(assistant)}>Disconnect</Button></div>
        <p className="mt-2 text-xs text-muted-foreground">{assistant.lastUsedAt?`Last used ${new Date(assistant.lastUsedAt).toLocaleString()}`:'Authorized. Waiting for the first MCP request.'}</p>
      </Card>)}
      {data.cursor&&<Button variant="outline" size="sm" disabled={busy!==null} onClick={async()=>{setBusy('more');try{const more=await api.get<AssistantList>(`/hosted/assistants?cursor=${encodeURIComponent(data.cursor!)}`);setData({...more,assistants:[...data.assistants,...more.assistants]});}catch{setError('Could not load more assistants');}finally{setBusy(null);}}}>Show more</Button>}
      <details className="mt-4 text-xs text-muted-foreground"><summary className="cursor-pointer font-medium">Connect another assistant</summary><p className="mt-2">Use this URL in your assistant’s MCP connector settings, then sign in to Elf.</p><code className="mt-2 block break-all rounded-lg border bg-card p-3">{data.connectorUrl}</code></details>
    </>}
  </section>;
}
function Settings() {
  const {getToken,isLoaded,isSignedIn}=useAuth();
  const api=React.useMemo(()=>createApi(()=>getToken()),[getToken]);
  return <ApiProvider client={api}><main className="mx-auto w-full min-w-0 max-w-[420px] px-5 pb-8 pt-8 [overflow-wrap:anywhere]">
    <header className="mb-6 flex items-center justify-between gap-3"><div className="flex items-center gap-3"><img src={mascot} width={32} height={32} alt=""/><div><p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Elf</p><h1 className="text-[15px] font-medium">Settings</h1></div></div>{isSignedIn&&<UserButton/>}</header>
    {!isLoaded?<p role="status">Loading…</p>:!isSignedIn?<section><p className="mb-4 text-sm text-muted-foreground">Sign in to connect and manage your MCP assistants.</p><SignIn routing="hash" forceRedirectUrl={location.origin+location.pathname+location.search} appearance={{variables:{colorPrimary:'#6f3cfa',borderRadius:'0.5rem'},elements:{rootBox:{width:'100%',maxWidth:'100%'},cardBox:{width:'100%',maxWidth:'100%'}}}}/></section>:<>{isHostedReview()&&<HostedReviewScreen embedded/>}<Assistants/></>}
    <footer className="mt-6 text-center text-[11px] text-faint">Elf · your design system, connected</footer>
  </main></ApiProvider>;
}
document.documentElement.style.setProperty('--font-inter','"Inter Variable"');
document.documentElement.classList.toggle('dark',matchMedia('(prefers-color-scheme: dark)').matches);
const key=import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
createRoot(document.getElementById('root')!).render(key?<ClerkProvider publishableKey={key}><Settings/></ClerkProvider>:<p>Elf Settings sign-in is not configured.</p>);
