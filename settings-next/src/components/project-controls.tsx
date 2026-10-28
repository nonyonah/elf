"use client";
import {ComponentImport} from '@/components/component-import';
import { ComponentDescription, type PreparedDescription } from "@/components/component-description";
import { FigmaAccount } from "@/components/figma-account";
import { settingsFetch as fetch } from "@/lib/settings-api";
import { ProjectResults } from "@/components/project-results";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";

interface Plan {
  selection?: {kind:string;key:string};
  id: string;
  entries: { kind: string; key: string; name: string; action: string }[];
  issues: { kind: string; key: string; message: string; component?: string; action?: string; blocksApply?: boolean }[];
}
export interface ProjectRuntime {
  project?: {componentsPath?: string};
  mode?: "monitor" | "automatic";
  attention?: string | null;
  bridge?: { connected: boolean };
  root: string;
  integration?: { command: string; args: string[] };
  activity?: { id: string; at: string; type: string; message: string; changes?: {kind: string; key: string; name: string; action: string; before: string | null; after: string}[] }[];
}
const card = "mb-5 gap-0 rounded-2xl border-[0.5px] border-border bg-card shadow-none before:hidden";
const button = "h-7 shrink-0 rounded-lg px-3 text-xs shadow-none sm:text-xs";

export function ProjectControls({ runtime, onChanged }: { runtime: ProjectRuntime; onChanged: () => void }) {
  const [tokenImport,setTokenImport] = useState<{id:string;path:string;content:string;names:string[];issues:string[];limitations:string[]} | null>(null);
  const [importPath,setImportPath] = useState("figma.tokens.json");
  const [selection, setSelection] = useState<{kind:string;key:string} | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [description, setDescription] = useState<PreparedDescription | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [enableAuto, setEnableAuto] = useState(false);
  const [client, setClient] = useState("cursor");
  const [replace, setReplace] = useState(false);
  const run = async (action: string, body: unknown = {}) => {
    const response = await fetch(`/api/project/${action}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Elf-Request": "1" }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "This action could not be completed.");
    return result;
  };
  const review = async (automatic = false, resource?: {kind:string;key:string}) => {
    setSelection(resource ?? null);
    setBusy("plan"); setError(null); setMessage(null); setReplace(false); setEnableAuto(automatic);
    try { const next = await run("plan", resource ? {selection:resource} : {}); if (resource && (next.selection?.key!==resource.key || next.selection?.kind!==resource.kind)) throw new Error('Update and restart Elf before reviewing individual resources.'); setPlan(next); setEnableAuto(runtime.mode !== "automatic" && automatic && !next.issues.some((issue: { kind: string }) => issue.kind !== "unsupported")); } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(null); }
  };
  const prepare = async (component: string) => {
    setBusy("prepare"); setError(null); setMessage(null);
    try {setDescription(await run("prepare-component", {component})); setPlan(null);}
    catch (cause) {setError((cause as Error).message);}
    finally {setBusy(null);}
  };
  const apply = async () => {
    if (!plan) return;
    setBusy("apply"); setError(null);
    try {
      const result = await run("apply", { planId: plan.id, enableAuto, overwriteConflicts: replace && !enableAuto });
      setMessage(`${enableAuto ? "Automatic sync enabled. " : ""}${result.synced} ${result.synced === 1 ? "resource" : "resources"} synced${result.issues?.length ? "; some items still need attention" : ""}.`);
      setPlan(null); onChanged();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(null); }
  };
  const monitor = async () => {
    setBusy("monitor"); setError(null);
    try { await run("monitor"); onChanged(); setMessage("Automatic sync paused. Monitoring continues."); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(null); }
  };
  const conflicts = plan?.issues.some(issue => issue.kind === "conflict" && issue.blocksApply !== false) ?? false;
  const integration = runtime.integration;
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  const command = integration ? [integration.command, ...integration.args].map(quote).join(" ") : "";
  const snippet = !integration ? "" : client === "cursor"
    ? JSON.stringify({ mcpServers: { elf: { type: "stdio", command: integration.command, args: integration.args } } }, null, 2)
    : client === "claude" ? `claude mcp add --transport stdio --scope local elf -- ${command}`
    : `codex mcp add elf -- ${command}`;
  return <>
    <section aria-labelledby="sync-heading">
      <h2 id="sync-heading" className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Sync</h2>
      <Card className={card}>
        <div className="flex items-center gap-2.5 px-3.5 py-3">
          <div className="min-w-0 flex-1"><p className="text-[13px] font-medium leading-[1.55]">Automatic sync</p><p className="text-[12px] leading-[1.55] text-muted-foreground">Apply supported code changes to Figma on save</p></div>
          <Switch checked={runtime.mode === "automatic"} disabled={busy !== null} onCheckedChange={checked => { if (checked) void review(true); else void monitor(); }} aria-label="Automatic sync" className="h-5 w-9 shrink-0 p-[2px] [--thumb-size:--spacing(4)]" thumbClassName="data-checked:translate-x-4" />
        </div>
        <div className="flex items-center gap-2.5 border-t-[0.5px] border-border px-3.5 py-3">
          <p className="min-w-0 flex-1 text-[12px] leading-[1.55] text-muted-foreground">Review changes before writing to Figma</p>
          <Button variant="default" size="sm" className={`${button} border-[0.5px]`} disabled={busy !== null} loading={busy === "plan"} onClick={() => { void review(); }}>Review sync</Button>
        </div>
        {plan && <div className="border-t-[0.5px] border-border px-3.5 py-3">
          <h3 className="text-[13px] font-medium leading-[1.55]">{plan.entries.length ? `${plan.entries.length} planned ${plan.entries.length === 1 ? "change" : "changes"}` : "No supported changes to apply"}</h3>
          <p className="mb-3 mt-1 text-[11.5px] leading-[1.55] text-faint">Only the listed changes will be applied. Other items stay unchanged for review. A fresh review is required if code or Figma changes.</p>
          {plan.entries.length > 0 && <ul className="mb-3 max-h-52 space-y-2 overflow-auto text-[12px] leading-[1.55]">{plan.entries.map(entry => <li className="flex items-start justify-between gap-3" key={`${entry.kind}:${entry.key}`}><span className="min-w-0 break-words">{entry.name}<span className="ml-1 text-faint">· {entry.kind}</span></span><span className="shrink-0 text-muted-foreground">{entry.action === "create" ? "Create" : "Update"}<Button size="sm" className={`${button} ml-2`} disabled={busy !== null} onClick={() => void review(false,{kind:entry.kind,key:entry.key})}>Review only</Button></span></li>)}</ul>}
          {plan.issues.length > 0 && <details open className="mb-3 text-[12px] leading-[1.55]"><summary className="cursor-pointer text-warning">{plan.issues.length} {plan.issues.length === 1 ? "item needs" : "items need"} attention</summary><ul className="mt-2 max-h-48 space-y-2 overflow-auto text-muted-foreground">{plan.issues.map((issue, index) => <li key={`${issue.key}:${index}`} className="break-words"><p>{issue.message}</p>{issue.action === "prepare-component" && issue.component && <Button size="sm" className={`${button} mt-2`} disabled={busy !== null} loading={busy === "prepare"} onClick={() => void prepare(issue.component!)}>Prepare description</Button>}</li>)}</ul></details>}
          {conflicts && !enableAuto && <label className="mb-3 flex items-start gap-2 text-[12px] leading-[1.55]"><input type="checkbox" className="mt-0.5 accent-primary" checked={replace} onChange={event => setReplace(event.target.checked)} /><span>Replace Figma edits affecting the planned changes with code values</span></label>}
          {runtime.mode !== "automatic" && !selection && <label className="mb-3 flex items-start gap-2 text-[12px] leading-[1.55]"><input type="checkbox" className="mt-0.5 accent-primary" checked={enableAuto} onChange={event => setEnableAuto(event.target.checked)} /><span>Keep syncing supported changes after this review<span className="block text-[11.5px] text-faint">Blocked resources and their dependents stay pending while safe changes continue.</span></span></label>}
          {runtime.mode === "automatic" && <p className="mb-3 text-[11.5px] leading-[1.55] text-faint">Automatic sync continues for safe resources. Conflicting resources and their dependents stay pending.</p>}
          <div className="flex items-center justify-end gap-2"><Button variant="default" size="sm" className={button} disabled={busy !== null} onClick={() => setPlan(null)}>Cancel</Button><Button size="sm" className={button} loading={busy === "apply"} disabled={busy !== null || (conflicts && !replace && !enableAuto) || (!plan.entries.length && !enableAuto)} onClick={() => { void apply(); }}>{enableAuto ? "Apply and enable" : "Apply sync"}</Button></div>
        </div>}
      </Card>
    </section>
    {description && <ComponentDescription key={`${description.codeKey}:${description.reviewHash}`} prepared={description} onClose={() => setDescription(null)} onSaved={(result) => {setDescription(null); setPlan(null); setMessage(result?.syncReady === false ? "Description uploaded and saved. Token bindings need review before Figma sync." : "Reviewed description saved locally."); if (result?.syncReady !== false) void review(false,{kind:"component",key:description.codeKey}); onChanged();}} />}
    {error && <p role="alert" className="mb-4 text-[12px] leading-[1.55] text-destructive">{error}</p>}
    {message && <p role="status" className="mb-4 text-[12px] leading-[1.55] text-muted-foreground">{message}</p>}
    <section aria-labelledby="token-import-heading"><h2 id="token-import-heading" className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Figma → code</h2><Card className={card}><div className="px-3.5 py-3"><p className="text-[13px] font-medium">Import Figma tokens</p><p className="my-2 text-[12px] text-muted-foreground">Create a new JSON file with modes and alias source data. Existing tokens are skipped. CSS and Tailwind files are not rewritten.</p><label htmlFor="token-import-path" className="text-[12px]">New filename</label><input id="token-import-path" value={importPath} onChange={event => {setImportPath(event.target.value);setTokenImport(null);}} className="my-2 h-8 w-full rounded-lg border-[0.5px] border-input bg-card px-2 text-[12px]" /><Button size="sm" className={button} disabled={busy!==null} onClick={() => {setBusy('import');setError(null);void run('plan-token-import',{path:importPath}).then(setTokenImport).catch(cause => setError(cause.message)).finally(() => setBusy(null));}}>Preview token import</Button>
    {tokenImport && <div className="mt-3"><p className="text-[12px]">{tokenImport.names.length} new tokens → {tokenImport.path}</p><pre className="my-2 max-h-64 overflow-auto rounded-lg border-[0.5px] border-border bg-background p-2 text-[11px]">{tokenImport.content}</pre>{[...tokenImport.issues,...tokenImport.limitations].map((issue,index) => <p key={index} className="my-1 text-[12px] text-muted-foreground">{issue}</p>)}<Button size="sm" className={button} disabled={busy!==null || !tokenImport.names.length} onClick={() => {if (!window.confirm(`Create ${tokenImport.path} with ${tokenImport.names.length} reviewed tokens and pause automatic sync?`)) return;setBusy('import');setError(null);void run('apply-token-import',{planId:tokenImport.id}).then(() => {setMessage('Reviewed token file created.');setTokenImport(null);onChanged();}).catch(cause => setError(cause.message)).finally(() => setBusy(null));}}>Create reviewed token file</Button><Button size="sm" className={`${button} ml-2`} disabled={busy!==null} onClick={() => setTokenImport(null)}>Cancel</Button></div>}</div></Card></section>
    <ComponentImport onChanged={onChanged} />
    <FigmaAccount />
    <section aria-labelledby="figma-connection-heading"><h2 id="figma-connection-heading" className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Figma connection</h2><Card className={card}><div className="flex items-center gap-2.5 px-3.5 py-3"><div className="min-w-0 flex-1"><p className="text-[13px] font-medium leading-[1.55]">{runtime.bridge?.connected === false ? "Figma disconnected" : "Saved pairing"}</p><p className="text-[12px] leading-[1.55] text-muted-foreground">{runtime.bridge?.connected === false ? "Request a code to reconnect this file" : "Disconnect to require a new pairing code"}</p></div><Button variant="default" size="sm" className={`${button} border-[0.5px]`} disabled={busy !== null} loading={busy === "disconnect"} onClick={() => { setBusy("disconnect"); setError(null); void run(runtime.bridge?.connected === false ? "pairing-code" : "disconnect-figma").then(() => { setMessage(runtime.bridge?.connected === false ? "A new pairing code is printed in your terminal." : "Figma pairing revoked. Pair this file again to reconnect."); onChanged(); }).catch(cause => setError(cause.message)).finally(() => setBusy(null)); }}>{runtime.bridge?.connected === false ? "New code" : "Disconnect"}</Button></div></Card></section>
    {integration && <section aria-labelledby="assistants-heading"><h2 id="assistants-heading" className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Coding assistants</h2><Card className={card}><details className="px-3.5 py-3"><summary className="cursor-pointer text-[13px] font-medium leading-[1.55]">Connect Cursor, Claude Code, or Codex</summary><p className="mb-3 mt-2 text-[12px] leading-[1.55] text-muted-foreground">Use the same Figma connection to check drift and prepare reviewed components.</p><label htmlFor="assistant-client" className="sr-only">Coding assistant</label><select id="assistant-client" value={client} onChange={event => setClient(event.target.value)} className="mb-2 h-8 w-full rounded-lg border-[0.5px] border-input bg-card px-2 text-[12px]"><option value="cursor">Cursor</option><option value="claude">Claude Code</option><option value="codex">Codex</option></select><p className="mb-2 text-[11.5px] text-faint">{client === "cursor" ? "Add this to .cursor/mcp.json in your project." : "Run this command in your terminal."}</p><pre className="overflow-x-auto rounded-lg border-[0.5px] border-border bg-background p-2 text-[11px] leading-relaxed">{snippet}</pre><p className="mt-2 text-[11.5px] leading-[1.55] text-faint">Ask your assistant to check drift, prepare a component description, or show a sync plan. Keep the Figma plugin open.</p></details></Card></section>}
    <ProjectResults onChanged={onChanged} />

  </>;
}
