"use client";
import {useState} from 'react';
import {Button} from '@/components/ui/button';
import {Card} from '@/components/ui/card';
import {settingsFetch,settingsJson} from '@/lib/settings-api';

export function DesignSystem() {
  const [path,setPath]=useState('DESIGN_SYSTEM.md');
  const [prepared,setPrepared]=useState<any>(null);
  const [draft,setDraft]=useState('');
  const [result,setResult]=useState<any>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const run=async(action:string,body:unknown)=>settingsJson(await settingsFetch(`/api/project/${action}`,{method:'POST',headers:{'Content-Type':'application/json','X-Elf-Request':'1'},body:JSON.stringify(body)}));
  const work=async(task:()=>Promise<void>)=>{setBusy(true);setError('');try{await task();}catch(error){setError((error as Error).message);}finally{setBusy(false);}};
  return <section aria-labelledby="design-system-heading">
    <h2 id="design-system-heading" className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Design system from Markdown · preview</h2>
    <Card className="mb-5 min-w-0 gap-3 rounded-2xl border-[0.5px] border-border bg-card p-3.5 shadow-none before:hidden">
      <p className="text-[12px] leading-[1.55] text-muted-foreground">Use your existing Claude-generated design-system document. This preview prepares an editable extraction draft. Creating Figma resources comes in the next stage.</p>
      <label htmlFor="design-system-path" className="text-[12px]">Markdown file in this project</label>
      <input id="design-system-path" value={path} disabled={busy} onChange={event=>{setPath(event.target.value);setPrepared(null);setResult(null);}} className="h-8 min-w-0 w-full rounded-lg border border-input bg-background px-2 text-[12px]" />
      <Button size="sm" disabled={busy||!path.trim()} onClick={()=>void work(async()=>{const p=await run('prepare-design-system',{path});setPrepared(p);setDraft(JSON.stringify(p.draft,null,2));setResult(null);})}>Prepare Markdown</Button>
      {prepared&&<>
        <details className="min-w-0 text-[12px]"><summary className="cursor-pointer">Review source and extraction instructions</summary><pre className="my-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background p-2">{prepared.source.markdown}</pre><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">{prepared.instructions}</pre></details>
        <p className="text-[12px] text-muted-foreground">Extract with AI in the Elf extension or through MCP, then review the JSON here. Preparing this source makes no external model request.</p>
        <label htmlFor="design-system-draft" className="text-[12px]">Editable extraction draft</label>
        <textarea id="design-system-draft" value={draft} maxLength={128000} onChange={event=>{setDraft(event.target.value);setResult(null);}} className="min-h-64 min-w-0 w-full rounded-lg border border-input bg-background p-2 font-mono text-[11px]" spellCheck={false} />
        <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={()=>void work(async()=>{setResult(await run('validate-design-system',{id:prepared.id,draft:JSON.parse(draft)}));})}>Validate draft</Button><Button size="sm" disabled={busy} onClick={()=>{setPrepared(null);setResult(null);setDraft('');}}>Close</Button></div>
        {result&&<div role="status" className="text-[12px] leading-[1.55]"><p>{result.reviewReady?'Extraction validation passed. Figma creation is not enabled in this preview.':'Resolve these extraction issues:'}</p><ul className="mt-2 list-disc space-y-1 ps-4">{result.issues.map((issue:string,index:number)=><li key={index}>{issue}</li>)}</ul>{result.limitations.map((limitation:string)=><p className="mt-2 text-muted-foreground" key={limitation}>{limitation}</p>)}</div>}
      </>}
      {error&&<p role="alert" className="text-[12px] text-destructive">{error}</p>}
    </Card>
  </section>;
}
