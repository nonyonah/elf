"use client";
import { useEffect, useRef, useState } from "react";
import { settingsFetch, settingsJson } from "@/lib/settings-api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export interface PreparedDescription {
  name: string; codeKey: string; file: string; path: string; reviewHash: string;
  existing: boolean; warning: string | null; sidecar: Record<string, unknown>;
  source: string; sourceTruncated: boolean;
  variantProps: {name: string; values: string[]}[];
  tokens: {key: string; name: string; type: string}[]; tokenCount: number;
}
const input = "mt-1 h-8 w-full rounded-lg border-[0.5px] border-input bg-background px-2 text-[12px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";
const button = "h-7 rounded-lg px-3 text-xs shadow-none sm:text-xs";
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function ComponentDescription({prepared, onClose, onSaved}: {prepared: PreparedDescription; onClose: () => void; onSaved: (result?: {syncReady?: boolean}) => void}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {heading.current?.focus();}, []);
  const [raw, setRaw] = useState(JSON.stringify(prepared.sidecar, null, 2));
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  let description: Record<string, unknown> | null = null;
  try {const parsed = JSON.parse(raw); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) description = parsed;} catch {}
  const edit = (value: string) => {setRaw(value); setReviewed(false); setError(null);};
  const field = (key: string, value: unknown, nested?: string) => {
    if (!description) return;
    edit(JSON.stringify({...description, [key]: nested ? {...object(description[key]), [nested]: value} : value}, null, 2));
  };
  const size = object(description?.size); const text = object(description?.text);
  const variants = object(description?.variants);
  const numericOrToken = (value: string): string | number | undefined => value.trim() ? Number.isFinite(Number(value)) ? Number(value) : value.trim() : undefined;
  const save = async () => {
    if (!description || !reviewed) return;
    setBusy(true); setError(null);
    try {
      const result = await settingsFetch("/api/project/save-description", {method: "POST", headers: {"Content-Type": "application/json", "X-Elf-Request": "1"}, body: JSON.stringify({component: prepared.codeKey, description, reviewHash: prepared.reviewHash})}).then(settingsJson);
      onSaved(result);
    } catch (cause) {setError((cause as Error).message);} finally {setBusy(false);}
  };
  return <section aria-labelledby="component-review-heading" className="mb-5">
    <h2 ref={heading} tabIndex={-1} id="component-review-heading" className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Component description</h2>
    <Card className="gap-0 rounded-2xl border-[0.5px] border-border bg-card shadow-none before:hidden">
      <div className="space-y-3 px-3.5 py-3">
        <div><h3 className="text-[13px] font-medium">Review {prepared.name}</h3><p className="mt-1 break-all text-[11px] text-faint">{prepared.file}</p></div>
        <p className="text-[12px] leading-[1.55] text-muted-foreground">{prepared.existing ? "Review the existing description against your component." : "These starting values are placeholders. Adjust them to match your design; Elf has not reconstructed the component’s appearance."}</p>
        {prepared.warning && <p role="alert" className="text-[12px] text-warning">{prepared.warning}</p>}
        <fieldset disabled={busy || !description} className="grid grid-cols-2 gap-3 disabled:opacity-60">
          <label className="text-[12px]">Layout<select className={input} value={String(description?.layoutMode ?? "")} onChange={event => field("layoutMode", event.target.value || undefined)}><option value="">Default</option><option value="HORIZONTAL">Horizontal</option><option value="VERTICAL">Vertical</option><option value="NONE">No auto layout</option></select></label>
          <label className="text-[12px]">Gap or token<input className={input} value={String(description?.gap ?? "")} onChange={event => field("gap", numericOrToken(event.target.value))} /></label>
          <label className="text-[12px]">Width<input type="number" min="1" className={input} value={String(size.width ?? "")} onChange={event => field("size", event.target.value ? Number(event.target.value) : undefined, "width")} /></label>
          <label className="text-[12px]">Height<input type="number" min="1" className={input} value={String(size.height ?? "")} onChange={event => field("size", event.target.value ? Number(event.target.value) : undefined, "height")} /></label>
          <label className="col-span-2 text-[12px]">Label<input className={input} value={String(text.characters ?? "")} onChange={event => field("text", event.target.value, "characters")} /></label>
          <label className="text-[12px]">Font size or token<input className={input} value={String(text.fontSize ?? "")} onChange={event => field("text", numericOrToken(event.target.value), "fontSize")} /></label>
          <label className="text-[12px]">Corner radius or token<input className={input} value={String(description?.cornerRadius ?? "")} onChange={event => field("cornerRadius", numericOrToken(event.target.value))} /></label>
          <label className="text-[12px]">Padding or token<input className={input} value={String(object(description?.padding).all ?? "")} onChange={event => field("padding", numericOrToken(event.target.value), "all")} /></label>
          <label className="text-[12px]">Background token<input list="component-color-tokens" className={input} value={typeof description?.fill === "string" ? description.fill : ""} onChange={event => field("fill", event.target.value || undefined)} /></label>
        </fieldset>
        {prepared.variantProps.length > 0 && <div className="text-[12px] leading-[1.55]"><p className="font-medium">Discovered variants</p>{prepared.variantProps.map(prop => <p key={prop.name} className="break-words text-muted-foreground">{prop.name}: {prop.values.join(", ")}</p>)}<p className="mt-1 text-faint">Review variant-specific appearance in the advanced description.</p></div>}
        <datalist id="component-color-tokens">{prepared.tokens.filter(token => token.type === "COLOR").map(token => <option key={token.key} value={token.key} />)}</datalist>
        {Object.keys(variants).length > 0 && <fieldset disabled={busy || !description} className="space-y-2"><legend className="mb-2 text-[12px] font-medium">Variant backgrounds</legend>{Object.entries(variants).map(([name, value]) => <label key={name} className="block text-[12px]">{name}<input list="component-color-tokens" className={input} placeholder="Inherit background" value={typeof object(value).fill === "string" ? String(object(value).fill) : ""} onChange={event => field("variants", {...object(value), fill: event.target.value || undefined}, name)} /></label>)}</fieldset>}
        <details className="text-[12px]"><summary className="cursor-pointer font-medium">Advanced description and token references</summary><p className="my-2 text-muted-foreground">Edit token bindings, padding, child components and variant overrides. Invalid fields are rejected. Unresolved token bindings can be saved and reviewed before Figma sync.</p><label htmlFor="component-description-json" className="sr-only">Figma description JSON</label><textarea id="component-description-json" spellCheck={false} disabled={busy} value={raw} onChange={event => edit(event.target.value)} className="min-h-64 w-full rounded-lg border-[0.5px] border-input bg-background p-2 font-mono text-[11px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" /><p className="mt-2 text-faint">{prepared.tokenCount} available tokens{prepared.tokenCount > prepared.tokens.length ? `; showing ${prepared.tokens.length}` : ""}</p><ul className="mt-1 max-h-32 overflow-auto font-mono text-[11px] text-muted-foreground">{prepared.tokens.map(token => <li key={token.key}>{token.key} · {token.type}</li>)}</ul></details>
        <details className="text-[12px]"><summary className="cursor-pointer font-medium">View component source{prepared.sourceTruncated ? " (excerpt)" : ""}</summary><pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background p-2 font-mono text-[11px]">{prepared.source}</pre></details>
        {!description && <p role="alert" className="text-[12px] text-destructive">The advanced description must be a valid JSON object.</p>}
        <label className="flex items-start gap-2 text-[12px] leading-[1.55]"><input type="checkbox" className="mt-0.5 accent-primary" checked={reviewed} disabled={busy || !description} onChange={event => setReviewed(event.target.checked)} /><span>I reviewed the layout, content, variants and token bindings.</span></label>
        <p className="break-words text-[11.5px] leading-[1.55] text-faint">Saves {prepared.path} locally and pauses automatic sync. Review a fresh sync plan before applying changes to Figma.</p>
        {error && <p role="alert" className="text-[12px] text-destructive">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2"><Button size="sm" className={button} disabled={busy} onClick={onClose}>Cancel</Button><Button size="sm" className={button} loading={busy} disabled={busy || !reviewed || !description} onClick={() => void save()}>Save reviewed description</Button></div>
      </div>
    </Card>
  </section>;
}
