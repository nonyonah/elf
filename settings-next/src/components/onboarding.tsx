"use client";
import { FigmaAccount } from "@/components/figma-account";
import { settingsFetch as fetch, openConnection } from "@/lib/settings-api";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CircleAlert, Shapes, FolderOpen, Radio, Terminal } from "lucide-react";
import { SupportFooter } from "@/components/support-footer";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { ProjectRuntime } from "@/components/project-controls";
import { Switch } from "@/components/ui/switch";

export interface OnboardingStatus extends ProjectRuntime {
  active: boolean;
  configured: boolean;
  root: string;
  sources: string[];
  discoveredComponents?: number;
  bridge: { connected: boolean; file: { key: string; name: string } | null };
  running: boolean;
  pluginManifest: string;
  error: string | null;
  project?: { tokenPath: string; source: string; componentsPath: string };
  checking?: boolean;
  lastCheck?: { status: string; total?: number; checkedAt: string } | null;
}

const card = "gap-0 rounded-2xl border-[0.5px] border-border bg-card shadow-none before:hidden";
const smallButton = "h-7 shrink-0 rounded-lg px-3 text-xs shadow-none sm:text-xs";

async function api(path: string, body?: unknown): Promise<any> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Elf-Request": "1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? "Could not complete this step. Try again.");
  return data;
}

export function Onboarding({ initial, onFinished }: { initial: OnboardingStatus; onFinished: () => void }) {
  const [status, setStatus] = useState(initial);
  const [step, setStep] = useState(initial.configured ? 2 : 0);
  const [slack, setSlack] = useState<{ connected: boolean; teamName?: string; channel?: string }>({ connected: false });
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slackTested, setSlackTested] = useState(false);
  const [pairingRequested, setPairingRequested] = useState(false);
  const [offline, setOffline] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  useEffect(() => {
    let disposed = false;
    let timeout: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const res = await fetch("/api/onboarding");
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (!disposed) { setStatus(data); setOffline(false); if (data.running) onFinishedRef.current(); }
      } catch { if (!disposed) setOffline(true); }
      if (!disposed) timeout = setTimeout(poll, 2000);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timeout); };
  }, []);

  useEffect(() => {
    heading.current?.focus();
    setError(null);
  }, [step]);

  useEffect(() => {
    let disposed = false;
    const refresh = () => { void fetch("/api/config").then(res => res.json()).then(data => {
      if (!disposed && data.slack) setSlack(data.slack);
    }).catch(() => {}); };
    refresh(); window.addEventListener("focus", refresh);
    const params = new URLSearchParams(window.location.search);
    if (params.has("figma")) setStep(1);
    if (params.get("slack") === "error") setError("Slack connection failed. Try again, or continue without Slack.");
    if (params.has("slack")) { params.delete("slack"); window.history.replaceState(null, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`); }
    return () => { disposed = true; window.removeEventListener("focus", refresh); };
  }, []);

  const validateProject = async () => {
    setBusy(true); setError(null);
    try {
      await api("/api/onboarding/validate", { tokenPath: "auto", source: "auto", autoSync: false });
      setStep(1);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const saveProject = async () => {
    setBusy(true); setError(null);
    try {
      await api("/api/onboarding", { tokenPath: "auto", source: "auto", autoSync: false });
      setStep(2);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const requestPairing = async () => {
    setBusy(true); setError(null);
    try { await api("/api/onboarding/pairing"); setPairingRequested(true); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const connectSlack = async () => {
    setBusy(true); setError(null);
    try {
      const result = await api("/api/slack/connect");
      const target = new URL(result.url);
      if (target.protocol !== "https:" || target.origin !== (result.authorizationOrigin ?? "https://slack.com")) throw new Error("Slack returned an unexpected connection address.");
      openConnection(target.href);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const disconnectSlack = async () => {
    setBusy(true); setError(null);
    try {
      await api("/api/slack/disconnect");
      setSlack({ connected: false }); setSlackTested(false); setNotify(false);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const testSlack = async () => {
    setBusy(true); setError(null);
    try { await api("/api/slack/test"); setSlackTested(true); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const start = async () => {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/config", {
        method: "PATCH", headers: { "Content-Type": "application/json", "X-Elf-Request": "1" },
        body: JSON.stringify({ notify: { enabled: slack.connected && notify, onlyOnChange: true } }),
      });
      if (!response.ok) throw new Error("Could not save notification preferences. Try again.");
      await api("/api/onboarding/start");
      onFinished();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const connected = status.bridge.connected && Boolean(status.bridge.file?.key) && !offline;
  const titles = ["Your project", "Connect Figma", "Stay in the loop"];

  return (
    <main className="mx-auto w-full min-w-0 max-w-[420px] [overflow-wrap:anywhere] px-5 pb-6 pt-8">
      <p className="mb-1 text-[15px] font-medium leading-[1.55]">Set up elf</p>
      <p className="mb-5 truncate text-[11.5px] leading-[1.55] text-faint" title={status.root}>{status.root}</p>
      <div className="mb-5 flex items-center gap-3"><img src="/brand/elf-mascot.png" width={40} height={40} alt="" /><div><p className="text-[15px] font-semibold">Elf</p><p className="text-[12px] text-muted-foreground">Your design system companion</p></div></div>
      <ol aria-label="Setup progress" className="mb-6 flex items-center gap-3 text-[11px] leading-[1.55] text-faint">
        {["Project", "Figma", "Notifications"].map((label, i) => (
          <li key={label} aria-current={i === step ? "step" : undefined} className={`flex items-center gap-1.5 ${i === step ? "font-medium text-foreground" : ""}`}>
            <span className={`flex size-4 items-center justify-center rounded-full text-[10px] ${i <= step ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
              {i < step ? <Check className="size-2.5" aria-hidden="true" /> : i + 1}
            </span>
            {label}
          </li>
        ))}
      </ol>
      <h1 ref={heading} tabIndex={-1} className="mb-1 text-[15px] font-medium leading-[1.55] outline-none">{titles[step]}</h1>
      <p className="mb-4 text-[12px] leading-[1.55] text-muted-foreground">
        {step === 0 ? "Elf discovers design tokens and components in your project automatically." : step === 1 ? "Pair this project with the file you want to check." : "Get a message when your code and Figma drift apart."}
      </p>

      {step === 0 && <>
        <Card className={`${card} mb-4`}>
          <div className="flex items-start gap-2.5 border-b-[0.5px] border-border px-3.5 py-3">
            <FolderOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0"><p className="text-[13px] font-medium leading-[1.55]">Local project</p><p className="mt-0.5 break-all text-[12px] leading-[1.55] text-muted-foreground">{status.root}</p></div>
          </div>
          <div className="space-y-3 px-3.5 py-3">
            <p className="text-[13px] font-medium">Found in your project</p>
            <p className="text-[12px] leading-[1.55] text-muted-foreground">Elf scans for CSS variables, token JSON, Tailwind themes, and component source files. New files are discovered while you work.</p>
            {status.sources.length > 0 ? <ul className="space-y-1 text-[12px] leading-[1.55] text-muted-foreground">{status.sources.map(path => <li key={path} className="break-all">{path}</li>)}</ul> : <p className="text-[12px] leading-[1.55] text-muted-foreground">No token sources found yet. You can continue and add them as you work.</p>}
            <p className="text-[12px] leading-[1.55] text-muted-foreground">{status.discoveredComponents ?? 0} component {(status.discoveredComponents ?? 0) === 1 ? "file" : "files"} found</p>
            <p className="text-[11.5px] leading-[1.55] text-faint">Dependencies, generated files, tests, and symlinks are excluded. Scanning does not change your files or Figma.</p>
          </div>
        </Card>
        <p className="mb-5 text-[11.5px] leading-[1.55] text-faint">Wrong folder? Stop elf and run it from your project folder.</p>
      </>}

      {step === 1 && <>
        <FigmaAccount />
        <Card className={`${card} mb-4`}>
          <div className="flex flex-wrap items-center gap-2.5 px-3.5 py-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted"><Shapes className="size-5" aria-hidden="true" /></span>
            <div className="min-w-[min(100%,9rem)] flex-1"><p className="text-[13px] font-medium leading-[1.55]">{connected ? "Connected" : offline ? "Elf is offline" : "Waiting for Figma"}</p><p role="status" className="text-[12px] leading-[1.55] text-muted-foreground">{connected ? status.bridge.file?.name : offline ? "Keep the elf terminal running" : "Open the Elf bridge plugin in your file"}</p></div>
            {connected && <Check className="size-4 shrink-0 text-success" aria-label="Connected" />}
          </div>
          {!connected && <ol className="space-y-3 border-t-[0.5px] border-border px-3.5 py-3 text-[12px] leading-[1.55] text-muted-foreground">
            <li>1. Open the Figma file you want to connect.</li>
            <li>2. Open the Elf bridge plugin.</li>
            <li className="flex gap-2"><Terminal className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /><span>3. Paste the pairing code printed in your terminal into the plugin.</span></li>
          </ol>}
        </Card>
        <details className="mb-4 text-[11.5px] leading-[1.55] text-muted-foreground"><summary className="cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">First time installing the plugin?</summary><p className="mt-2">In Figma, open Plugins → Development → Import plugin from manifest. Choose:</p><p className="mt-1 break-all rounded-lg border-[0.5px] border-border bg-card p-2 font-mono text-[11px]">{status.pluginManifest}</p></details>
        {!connected && <div className="mb-4"><Button variant="default" size="sm" className={`${smallButton} border-[0.5px]`} loading={busy} disabled={busy || offline} onClick={() => { void requestPairing(); }}>New pairing code</Button>{pairingRequested && <p role="status" className="mt-2 text-[11.5px] leading-[1.55] text-muted-foreground">A new code is printed in your terminal.</p>}</div>}
        <p className="mb-5 text-[11.5px] leading-[1.55] text-faint">The code expires after five minutes. Saved pairing survives restarts; keep the plugin open while checking drift.</p>
      </>}

      {step === 2 && <>
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Slack · optional</h2>
        <Card className={`${card} mb-5`}>
          <div className="flex flex-wrap items-center gap-2.5 px-3.5 py-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white ring-1 ring-black/5 dark:ring-white/10"><img src="https://a.slack-edge.com/80588/marketing/img/icons/icon_slack_hash_colored.png" alt="" width={24} height={24} className="size-6" /></span>
            <div className="min-w-[min(100%,9rem)] flex-1"><p className="text-[13px] font-medium leading-[1.55]">{slack.connected ? "Connected" : "Not connected"}</p><p className="text-[12px] leading-[1.55] text-muted-foreground">{slack.connected ? [slack.teamName, slack.channel].filter(Boolean).join(" · ") : "Send drift notifications to your team"}</p></div>
            <Button variant={slack.connected ? "destructive" : "default"} size="sm" className={smallButton} loading={busy} disabled={busy || offline} onClick={() => { void (slack.connected ? disconnectSlack() : connectSlack()); }}>{slack.connected ? "Disconnect" : "Connect Slack"}</Button>
          </div>
          {slack.connected && <div className="flex items-center justify-between gap-2 border-t-[0.5px] border-border px-3.5 py-3"><p role="status" className="text-[12px] text-muted-foreground">{slackTested ? "Test message sent" : "Check that messages reach your channel"}</p><Button variant="default" size="sm" className={`${smallButton} border-[0.5px]`} disabled={busy} onClick={() => { void testSlack(); }}>Send test</Button></div>}
          {slack.connected && <div className="flex flex-wrap items-center gap-2.5 border-t-[0.5px] border-border px-3.5 py-3"><div className="min-w-[min(100%,9rem)] flex-1"><p className="text-[13px] font-medium leading-[1.55]">Notify on drift</p><p className="text-[12px] leading-[1.55] text-muted-foreground">Only when the drift state changes</p></div><Switch checked={notify} onCheckedChange={setNotify} disabled={busy} aria-label="Notify on drift" className="h-5 w-9 shrink-0 p-[2px] [--thumb-size:--spacing(4)]" thumbClassName="data-checked:translate-x-4" /></div>}
        </Card>
        <Card className={`${card} mb-4`}><div className="flex items-start gap-2.5 px-3.5 py-3"><Radio className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><div><p className="text-[13px] font-medium leading-[1.55]">Ready to monitor</p><p className="mt-0.5 text-[12px] leading-[1.55] text-muted-foreground">Elf checks for drift when you save. Your Figma file stays as it is. Reports appear in your project{slack.connected && notify ? " and Slack" : ""}.</p></div></div></Card>
        <p className="mb-5 text-[11.5px] leading-[1.55] text-faint">Keep this terminal and the Figma plugin open. You can change notification preferences in Settings.</p>
      </>}

      {(error || offline) && <div role="alert" className="mb-4 flex items-start gap-2 text-[12px] leading-[1.55] text-destructive"><CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /><p>{error ?? "Couldn’t reach elf. Check that its terminal is still running."}</p></div>}
      <div className="mb-6 flex items-center justify-between gap-2">
        {step > 0 ? <Button variant="default" size="sm" className={smallButton} disabled={busy} onClick={() => setStep(step - 1)}><ArrowLeft className="size-3" aria-hidden="true" />Back</Button> : <span />}
        <Button size="sm" className={smallButton} loading={busy} disabled={busy || offline || (step > 0 && !connected)} onClick={() => { if (step === 0) void validateProject(); else if (step === 1) void saveProject(); else void start(); }}>
          {step === 2 ? "Start watching" : "Continue"}{step < 2 && <ArrowRight className="size-3" aria-hidden="true" />}
        </Button>
      </div>
      <SupportFooter />
    </main>
  );
}
