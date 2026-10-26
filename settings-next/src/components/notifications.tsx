"use client";
import { Bell, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { displayValue } from "@/components/project-results";
import type { ProjectRuntime } from "@/components/project-controls";

export function Notifications({activity = [], projectKey}: {activity?: ProjectRuntime["activity"]; projectKey: string}) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null); const trigger = useRef<HTMLButtonElement>(null);
  const storageKey = `elf.notifications.read:${projectKey}`;
  useEffect(() => { try { setSeen(localStorage.getItem(storageKey)); } catch { setSeen(null); } }, [storageKey]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  const markRead = () => { if (!activity.length) return; setSeen(activity[0].id); try { localStorage.setItem(storageKey, activity[0].id); } catch {} };
  const index = activity.findIndex(item => item.id === seen);
  const unread = index < 0 ? activity.length : index;
  return <div ref={root} className="relative shrink-0">
    <button ref={trigger} type="button" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"} aria-expanded={open} aria-controls="notifications-panel" aria-haspopup="dialog" onClick={() => { if (!open) markRead(); setOpen(!open); }} className="relative flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"><Bell className="size-4" aria-hidden="true" />{unread > 0 && <span aria-hidden="true" className="absolute right-1 top-1 size-1.5 rounded-full bg-warning" />}</button>
    {open && <div id="notifications-panel" role="dialog" aria-label="Notifications" className="absolute right-0 top-11 z-50 w-[min(360px,calc(100vw-40px))] overflow-hidden rounded-2xl border-[0.5px] border-border bg-card shadow-lg">
      <div className="flex items-center justify-between border-b-[0.5px] border-border px-3.5 py-3"><h2 className="text-[13px] font-medium">Notifications</h2><button type="button" aria-label="Close notifications" onClick={() => { setOpen(false); trigger.current?.focus(); }} className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"><X className="size-3.5" aria-hidden="true" /></button></div>
      {activity.length === 0 ? <p className="px-3.5 py-6 text-[12px] text-muted-foreground">No activity yet. Sync results and drift checks will appear here.</p> : <ol className="max-h-[min(70vh,480px)] overflow-y-auto">{activity.map((item, i) => <li key={item.id} className={`px-3.5 py-3 ${i ? "border-t-[0.5px] border-border" : ""}`}><p className={`break-words text-[12px] leading-[1.55] ${item.type === "error" || item.type === "conflict" ? "text-warning" : "text-foreground"}`}>{item.message}</p><time dateTime={item.at} className="mt-1 block text-[11px] text-faint">{new Date(item.at).toLocaleString([], {month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"})}</time>{Boolean(item.changes?.length) && <details className="mt-2 text-[12px]"><summary className="cursor-pointer text-muted-foreground">View {item.changes!.length} synced changes</summary><ul className="mt-2 space-y-3">{item.changes!.map((change, index) => <li key={`${change.key}:${index}`}><p className="break-words font-medium">{change.name} · {change.action} · {change.kind}</p><p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">Before: {displayValue(change.before)}</p><p className="mt-1 break-all font-mono text-[11px]">After: {displayValue(change.after)}</p></li>)}</ul></details>}</li>)}</ol>}
    </div>}
  </div>;
}
