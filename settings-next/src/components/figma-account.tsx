"use client";
import { useEffect, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { ChevronDown } from "lucide-react";
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
  return (
    <section aria-labelledby="figma-account-heading">
      <h2 id="figma-account-heading" className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Figma account · strict verification</h2>
      <Card className="mb-5 min-w-0 gap-0 rounded-2xl border-[0.5px] border-border bg-card shadow-none before:hidden">
        <div className="flex flex-wrap items-center gap-3 px-3.5 py-3">
          <div className="min-w-[min(100%,10rem)] flex-1">
            <p className="text-[13px] font-medium leading-[1.55]">{connected ? "Account connected" : "Verify your Figma files"}</p>
            <p className="mt-1 text-[12px] leading-[1.55] text-muted-foreground">Optional in plugin-only mode. Connect your account for independent file-link verification. Read-only access verifies the file; the paired plugin applies changes.</p>
          </div>
          <Button variant={connected ? "destructive" : "default"} size="sm" className="h-7 shrink-0 rounded-lg px-3 text-xs shadow-none" disabled={busy} onClick={() => void act()}>{connected ? "Disconnect" : "Connect Figma"}</Button>
        </div>
        <div className="border-t-[0.5px] border-border px-3.5 py-3">
          <Menu.Root>
            <Menu.Trigger disabled={busy} className="inline-flex min-h-7 max-w-full items-center gap-2 rounded-lg border border-primary bg-primary px-3 py-1 text-left text-xs font-medium text-primary-foreground hover:bg-[var(--primary-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60">
              Document verification <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner sideOffset={6} align="start" className="z-50 max-w-[calc(100vw-2rem)]">
                <Menu.Popup className="max-w-full rounded-xl border border-border bg-card p-1 text-[12px] text-foreground shadow-lg outline-none">
                  <Menu.Item disabled={busy} onClick={() => void approveDocument()} className="cursor-default rounded-lg px-3 py-2 outline-none data-highlighted:bg-muted">Approve open document without REST</Menu.Item>
                  <Menu.Item disabled={busy} onClick={() => void useStrict()} className="cursor-default rounded-lg px-3 py-2 outline-none data-highlighted:bg-muted">Require strict verification</Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
          <p className="mt-2 text-[12px] leading-[1.55] text-muted-foreground">Plugin approval requires fresh confirmation each connection and does not independently verify the file URL. Strict verification uses your Figma account and REST quota.</p>
          {notice && <p role="status" className="mt-2 text-[12px] text-muted-foreground">{notice}</p>}
        </div>
        {error && <p role="alert" className="px-3.5 pb-3 text-[12px] text-destructive">{error}</p>}
      </Card>
    </section>
  );
}
