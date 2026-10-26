"use client";
import { useState } from "react";
import { settingsFetch as fetch, settingsJson } from "@/lib/settings-api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const card = "mb-5 gap-0 rounded-2xl border-[0.5px] border-border bg-card shadow-none before:hidden";
const button = "h-7 shrink-0 rounded-lg px-3 text-xs shadow-none sm:text-xs";
interface Resource {kind: string; key: string; name: string; location: string; value: string; verified: boolean; recorded?: boolean; figmaUrl: string;}
export function displayValue(raw: string | null): string {
  if (raw === null) return "Not present";
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object" && Object.values(value).every(item => item && typeof item === "object" && ("value" in item || "id" in item))) {
      return Object.entries(value).map(([mode, item]) => `${mode}: ${JSON.stringify((item as any).value ?? (item as any).id)}`).join(" · ");
    }
  } catch {}
  return raw;
}
export function ProjectResults({onChanged}: {onChanged: () => void}) {
  const [report, setReport] = useState<{markdown: string; updatedAt: string} | null>(null);
  const [resources, setResources] = useState<{checkedAt: string; resources: Resource[]} | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const request = async (path: string, post = false) => {
    const response = await fetch(path, post ? {method: "POST", headers: {"X-Elf-Request": "1", "Content-Type": "application/json"}, body: "{}"} : {});
    if (!response.ok) await settingsJson(response.clone());
    return response;
  };
  const run = async (action: string) => {
    setBusy(action); setError(null); setMessage(null);
    try {
      if (action === "report") setReport(await settingsJson(await request("/api/report")));
      if (action === "download") {
        const blob = await (await request("/api/report/download")).blob();
        const url = URL.createObjectURL(blob); const link = document.createElement("a");
        link.href = url; link.download = "drift-report.md"; document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      if (action === "resources") setResources(await settingsJson(await request("/api/project/resources", true)));
      if (action === "check") { await settingsJson(await request("/api/project/check", true)); setReport(null); setMessage("Drift check requested. Wait for the project status to update, then open the latest report."); onChanged(); }
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(null); }
  };
  return <>
    <section aria-labelledby="report-heading"><h2 id="report-heading" className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Drift report</h2><Card className={card}>
      <div className="px-3.5 py-3"><p className="text-[13px] font-medium leading-[1.55]">Latest drift check</p><p className="mt-1 text-[12px] leading-[1.55] text-muted-foreground">A sync can succeed while other tokens still differ. Open the report to see what remains.</p><div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" size="sm" className={button} disabled={busy !== null} onClick={() => void run("report")}>View report</Button><Button variant="outline" size="sm" className={button} disabled={busy !== null} onClick={() => void run("download")}>Download .md</Button><Button variant="ghost" size="sm" className={button} disabled={busy !== null} onClick={() => void run("check")}>Check now</Button></div></div>
      {report && <div className="border-t-[0.5px] border-border px-3.5 py-3"><div className="mb-2 flex items-center justify-between gap-2"><p className="text-[11px] text-faint">Generated {new Date(report.updatedAt).toLocaleString()}</p><Button variant="ghost" size="sm" className={button} onClick={() => setReport(null)}>Close report</Button></div><pre aria-label="Drift report contents" className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border-[0.5px] border-border bg-background p-3 font-mono text-[11px] leading-relaxed">{report.markdown}</pre></div>}
    </Card></section>
    <section aria-labelledby="resources-heading"><h2 id="resources-heading" className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Synced resources</h2><Card className={card}><div className="px-3.5 py-3"><p className="text-[13px] font-medium leading-[1.55]">What reached Figma</p><p className="mt-1 text-[12px] leading-[1.55] text-muted-foreground">Inspect managed variables and components. Variables appear in Figma’s local variables panel; components appear on the canvas.</p><Button variant="outline" size="sm" className={`${button} mt-3`} disabled={busy !== null} onClick={() => void run("resources")}>{resources ? "Refresh resources" : "View synced resources"}</Button></div>
      {resources && <div className="border-t-[0.5px] border-border"><p className="px-3.5 py-3 text-[11px] text-faint">{resources.resources.length} managed resources · checked {new Date(resources.checkedAt).toLocaleTimeString()}</p>{resources.resources.length === 0 && <p className="px-3.5 pb-3 text-[12px] text-muted-foreground">No managed resources recorded yet. Review and apply a sync first.</p>}<ul className="max-h-96 overflow-auto">{resources.resources.map(item => <li key={`${item.kind}:${item.key}`} className="border-t-[0.5px] border-border px-3.5 py-3"><div className="flex items-start justify-between gap-3"><p className="min-w-0 break-words text-[12px] font-medium">{item.name}</p><a href={item.figmaUrl} target="_blank" rel="noopener noreferrer" className="shrink-0 text-[11px] underline underline-offset-2">Open Figma</a></div><p className="mt-1 text-[11px] text-muted-foreground">{item.kind} · {item.location} · {item.verified ? "Matches last verified sync" : item.recorded ? "Last sync recorded; inspect in Figma" : "Needs verification or review"}</p><p className="mt-1 break-all font-mono text-[11px] leading-relaxed">{displayValue(item.value)}</p></li>)}</ul></div>}
    </Card></section>
    {message && <p role="status" className="mb-4 text-[12px] text-muted-foreground">{message}</p>}
    {error && <p role="alert" className="mb-4 text-[12px] text-destructive">{error}</p>}
  </>;
}
