"use client";
import { useEffect, useState } from "react";
import { settingsFetch as fetch, settingsJson } from "@/lib/settings-api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { figmaConnectionError } from "@/lib/connection-error";

export function FigmaAccount() {
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void fetch("/api/figma/account").then(settingsJson).then(data => {if (active) setConnected(data.connected);}).catch(cause => {if (active) setError(cause.message);});
    const params = new URLSearchParams(window.location.search);
    if (params.get("figma") === "error") setError(figmaConnectionError(params.get("figma_reason")));
    return () => {active = false;};
  }, []);
  const act = async () => {
    setBusy(true); setError(null);
    try {
      const data = await fetch(`/api/figma/${connected ? "disconnect" : "connect"}`, {method: "POST", headers: {"X-Elf-Request": "1"}}).then(settingsJson);
      if (connected) setConnected(false);
      else {
        const url = new URL(data.url);
        if (url.protocol !== "https:" || url.origin !== data.authorizationOrigin) throw new Error("Unexpected Figma connection address.");
        window.location.assign(url.href);
      }
    } catch (cause) {setError((cause as Error).message);} finally {setBusy(false);}
  };
  return <section aria-labelledby="figma-account-heading"><h2 id="figma-account-heading" className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Figma account</h2><Card className="mb-5 gap-0 rounded-2xl border-[0.5px] border-border bg-card shadow-none before:hidden"><div className="flex items-center gap-2.5 px-3.5 py-3"><div className="min-w-0 flex-1"><p className="text-[13px] font-medium leading-[1.55]">{connected ? "Account connected" : "Verify your Figma files"}</p><p className="mt-1 text-[12px] leading-[1.55] text-muted-foreground">Read-only account access verifies file links for the public plugin. Pairing controls writes separately.</p></div><Button variant="outline" size="sm" className="h-7 shrink-0 rounded-lg px-3 text-xs shadow-none" disabled={busy} onClick={() => void act()}>{connected ? "Disconnect" : "Connect Figma"}</Button></div>{error && <p role="alert" className="px-3.5 pb-3 text-[12px] text-destructive">{error}</p>}</Card></section>;
}
