"use client";
import { useEffect, useState } from "react";
import { settingsFetch as fetch, settingsJson, openConnection } from "@/lib/settings-api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { figmaConnectionError } from "@/lib/connection-error";

export function FigmaAccount() {
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const approveDocument = async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const pending = await fetch('/api/project/pending-document', {method:'POST',headers:{'X-Elf-Request':'1','Content-Type':'application/json'},body:'{}'}).then(settingsJson);
      if (!pending) throw new Error('Choose Plugin approval in the Figma plugin and connect first.');
      if (!window.confirm(`Approve the currently open document “${pending.file.name}” for this project (${pending.file.key})? The URL will not be independently verified. Automatic sync pauses. Fresh approval is required after reconnecting.`)) return;
      await fetch('/api/project/approve-document',{method:'POST',headers:{'X-Elf-Request':'1','Content-Type':'application/json'},body:JSON.stringify({fileKey:pending.file.key,ticket:pending.ticket,optIn:true})}).then(settingsJson);
      setNotice('Open document approved for this connection. URL identity was not verified.');
    } catch (cause) {setError((cause as Error).message);} finally {setBusy(false);}
  };
  const useStrict = async () => {
    if (!window.confirm('Require strict URL verification? The current plugin-only connection will close. Figma account access and REST quotas apply.')) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await fetch('/api/project/strict-authorization',{method:'POST',headers:{'X-Elf-Request':'1','Content-Type':'application/json'},body:'{}'}).then(settingsJson);
      setNotice('Strict verification required. Choose strict verification in the plugin and reconnect.');
    } catch (cause) {setError((cause as Error).message);} finally {setBusy(false);}
  };
  useEffect(() => {
    let active = true;
    const refresh = () => { void fetch("/api/figma/account").then(settingsJson).then(data => {if (active) setConnected(data.connected);}).catch(cause => {if (active) setError(cause.message);}); };
    refresh(); window.addEventListener("focus", refresh);
    const params = new URLSearchParams(window.location.search);
    if (params.get("figma") === "error") setError(figmaConnectionError(params.get("figma_reason")));
    return () => {active = false; window.removeEventListener("focus", refresh);};
  }, []);
  const act = async () => {
    setBusy(true); setError(null);
    try {
      const data = await fetch(`/api/figma/${connected ? "disconnect" : "connect"}`, {method: "POST", headers: {"X-Elf-Request": "1"}}).then(settingsJson);
      if (connected) setConnected(false);
      else {
        const url = new URL(data.url);
        if (url.protocol !== "https:" || url.origin !== data.authorizationOrigin) throw new Error("Unexpected Figma connection address.");
        openConnection(url.href);
      }
    } catch (cause) {setError((cause as Error).message);} finally {setBusy(false);}
  };
  return <section aria-labelledby="figma-account-heading"><h2 id="figma-account-heading" className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Figma account · strict verification</h2><Card className="mb-5 gap-0 rounded-2xl border-[0.5px] border-border bg-card shadow-none before:hidden"><div className="flex items-center gap-2.5 px-3.5 py-3"><div className="min-w-0 flex-1"><p className="text-[13px] font-medium leading-[1.55]">{connected ? "Account connected" : "Verify your Figma files"}</p><p className="mt-1 text-[12px] leading-[1.55] text-muted-foreground">Optional in plugin-only mode. Connect your account for independent file-link verification. Read-only access verifies the file; the paired plugin applies changes.</p></div><Button variant="default" size="sm" className="h-7 shrink-0 rounded-lg px-3 text-xs shadow-none" disabled={busy} onClick={() => void act()}>{connected ? "Disconnect" : "Connect Figma"}</Button></div>{error && <p role="alert" className="px-3.5 pb-3 text-[12px] text-destructive">{error}</p>}</Card><Button variant="default" size="sm" disabled={busy} onClick={() => void approveDocument()}>Approve open document without REST</Button><Button variant="default" size="sm" className="ml-2" disabled={busy} onClick={() => void useStrict()}>Require strict verification</Button>{notice && <p role="status" className="mt-2 text-[12px] text-muted-foreground">{notice}</p>}<p className="mt-2 text-[12px] text-muted-foreground">Plugin approval works without account verification, requires fresh confirmation each connection, and does not independently verify the file URL. Strict connections remain unchanged until you approve.</p></section>;
}
