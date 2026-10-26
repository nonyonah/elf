"use client";
import { settingsFetch as fetch } from "@/lib/settings-api";

import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ServerNotice } from "@/components/server-notice";
import { Notifications } from "@/components/notifications";
import { SupportFooter } from "@/components/support-footer";
import { ProjectControls } from "@/components/project-controls";
import { Onboarding, type OnboardingStatus } from "@/components/onboarding";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";

interface SlackInfo {
  connected: boolean;
  teamName?: string;
  channel?: string;
}

interface ProjectInfo {
  configPath: string;
  fileKey: string;
}

interface NotifyConfig {
  enabled: boolean;
  onlyOnChange: boolean;
}

type Saving = "connect" | "disconnect" | "notify" | "onlyOnChange" | "test" | null;

type ToastTone = "success" | "error" | "info";

interface ToastMessage {
  id: number;
  message: string;
  tone: ToastTone;
  retry?: boolean;
}

class SettingsApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export default function SettingsPage() {
  const [onboarding, setOnboarding] = useState<OnboardingStatus | null>(null);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [slack, setSlack] = useState<SlackInfo>({ connected: false });
  const [notify, setNotify] = useState<NotifyConfig>({
    enabled: false,
    onlyOnChange: false,
  });
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState<Saving>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const nextToastId = useRef(0);

  const showToast = useCallback(
    (
      message: string,
      tone: ToastTone = "success",
      options: { retry?: boolean } = {},
    ) => {
      nextToastId.current += 1;
      setToast({
        id: nextToastId.current,
        message,
        tone,
        retry: options.retry,
      });
    },
    [],
  );

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/config");
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status === 404) {
          throw new SettingsApiError(
            'Settings API not found. Start the page with "elf-tokens settings" (or "npm run settings"), not `next dev`.',
            404,
          );
        }
        throw new SettingsApiError(
          data?.error ?? `Failed to load settings (${res.status})`,
          res.status,
        );
      }
      setOnboarding(data?.onboarding ?? null);
      setProject({
        configPath: data?.project?.configPath ?? "",
        fileKey: data?.project?.fileKey ?? "",
      });
      setSlack({
        connected: Boolean(data?.slack?.connected),
        teamName: data?.slack?.teamName,
        channel: data?.slack?.channel,
      });
      setNotify({
        enabled: Boolean(data?.notify?.enabled),
        onlyOnChange: data?.notify?.onlyOnChange ?? true,
      });
      setLoadFailed(false);
    } catch (cause) {
      setLoadFailed(true);
      const missingApi = cause instanceof SettingsApiError && cause.status === 404;
      showToast(
        cause instanceof Error
          ? cause.message
          : "Couldn't reach the local elf server.",
        "error",
        { retry: !missingApi },
      );
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void fetchConfig();
  }, [fetchConfig]);

  useEffect(() => {
    if (!onboarding || onboarding.active) return;
    let disposed = false;
    const timer = setInterval(() => {
      void fetch("/api/onboarding").then(res => {
        if (!res.ok) throw new Error();
        return res.json();
      }).then(data => { if (!disposed) setOnboarding(data); }).catch(() => {
        if (!disposed) setOnboarding(previous => previous ? { ...previous, error: "Couldn’t reach elf. Keep its terminal running." } : null);
      });
    }, 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, [Boolean(onboarding), onboarding?.active]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const slack = params.get("slack");
    if (!slack) return;
    if (slack === "connected") {
      showToast("Slack connected");
      void fetchConfig();
    } else {
      showToast("Slack connection failed. Try again.", "error");
    }
    params.delete("slack");
    const search = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`,
    );
  }, [fetchConfig, showToast]);

  useEffect(() => {
    if (!toast || toast.tone === "error") return;
    const timeout = setTimeout(
      () => {
        setToast((current) => (current?.id === toast.id ? null : current));
      },
      toast.tone === "info" ? 6000 : 2200,
    );
    return () => clearTimeout(timeout);
  }, [toast]);

  const patchNotify = async (body: {
    enabled?: boolean;
    onlyOnChange?: boolean;
  }) => {
    const res = await fetch("/api/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Elf-Request": "1" },
      body: JSON.stringify({ notify: body }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(data?.error ?? "Could not save this setting.");
    }
  };

  const handleConnectSlack = async () => {
    setSaving("connect");
    try {
      const res = await fetch("/api/slack/connect", { method: "POST", headers: { "X-Elf-Request": "1" } });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          data?.error ?? `Failed to start Slack connection (${res.status})`,
        );
      }
      if (data?.url) {
        window.location.href = data.url;
        return;
      }
      showToast(
        data?.message ??
          "Run 'elf connect slack' in your terminal to connect Slack.",
        "info",
      );
    } catch (cause) {
      showToast(
        cause instanceof Error
          ? cause.message
          : "Failed to start Slack connection.",
        "error",
      );
    } finally {
      setSaving(null);
    }
  };

  const handleTestSlack = async () => {
    setSaving("test");
    try {
      const response = await fetch("/api/slack/test", { method: "POST", headers: { "X-Elf-Request": "1" } });
      if (!response.ok) throw new Error("Could not send the test message. Check your Slack connection.");
      showToast("Test message sent");
    } catch (error) { showToast((error as Error).message, "error"); }
    finally { setSaving(null); }
  };
  const handleDisconnectSlack = async () => {
    setSaving("disconnect");
    try {
      const res = await fetch("/api/slack/disconnect", { method: "POST", headers: { "X-Elf-Request": "1" } });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          data?.error ?? `Failed to disconnect Slack (${res.status})`,
        );
      }
      setSlack({ connected: false });
      showToast("Slack disconnected");
    } catch (cause) {
      showToast(
        cause instanceof Error
          ? cause.message
          : "Failed to disconnect Slack.",
        "error",
      );
    } finally {
      setSaving(null);
    }
  };

  const handleNotifyToggle = async (enabled: boolean) => {
    setNotify((previous) => ({ ...previous, enabled }));
    setSaving("notify");
    try {
      await patchNotify({ enabled });
      showToast("Saved");
    } catch (cause) {
      setNotify((previous) => ({ ...previous, enabled: !enabled }));
      showToast(
        cause instanceof Error
          ? cause.message
          : "Could not save notifications setting.",
        "error",
      );
    } finally {
      setSaving(null);
    }
  };

  const handleOnlyOnChangeToggle = async (onlyOnChange: boolean) => {
    setNotify((previous) => ({ ...previous, onlyOnChange }));
    setSaving("onlyOnChange");
    try {
      await patchNotify({ onlyOnChange });
      showToast("Saved");
    } catch (cause) {
      setNotify((previous) => ({ ...previous, onlyOnChange: !onlyOnChange }));
      showToast(
        cause instanceof Error
          ? cause.message
          : "Could not save notification preference.",
        "error",
      );
    } finally {
      setSaving(null);
    }
  };

  const busy = saving !== null;
  const unavailable = loading || loadFailed;
  const onlyOnChangeDisabled = unavailable || busy || !notify.enabled;

  const slackTitle = loading
    ? "Loading…"
    : slack.connected
      ? "Connected"
      : "Not connected";
  const slackSub = loading
    ? ""
    : slack.connected
      ? [slack.teamName, slack.channel].filter(Boolean).join(" · ")
      : "Connect to get drift notifications in Slack";

  if (onboarding?.active) return <Onboarding initial={onboarding} onFinished={() => { void fetchConfig(); }} />;

  return (
    <main className="mx-auto w-full max-w-[420px] px-5 pb-6 pt-8">
      <div className="mb-1 flex items-center justify-between gap-3"><h1 className="text-[15px] font-medium leading-[1.55]">Settings</h1><Notifications activity={onboarding?.activity} projectKey={project?.configPath ?? onboarding?.root ?? ""} /></div>
      {project?.configPath ? (
        <p
          className="mb-5 truncate text-[11.5px] leading-[1.55] text-faint"
          title={project.configPath}
        >
          {project.configPath}
        </p>
      ) : (
        <div className="mb-5" />
      )}

      <ServerNotice />

      {onboarding?.running && <section aria-labelledby="watching-heading">
        <h2 id="watching-heading" className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">Project</h2>
        <Card className="mb-5 gap-0 rounded-2xl border-[0.5px] border-border bg-card shadow-none before:hidden">
          <div className="px-3.5 py-3">
            <p className="flex items-center gap-2 text-[13px] font-medium leading-[1.55]"><span className={`size-1.5 rounded-full ${onboarding.error || onboarding.attention || !onboarding.bridge.connected ? "bg-warning" : "bg-success"}`} aria-hidden="true" />Watching for drift</p>
            <p className="mt-0.5 text-[12px] leading-[1.55] text-muted-foreground">{onboarding.bridge.file?.name ?? "Waiting for Figma"} · {onboarding.mode === "automatic" ? "Automatic sync" : "Monitoring"}</p>
            <p role="status" className={`mt-1.5 text-[11.5px] leading-[1.55] ${onboarding.error || onboarding.attention ? "text-warning" : "text-faint"}`}>
              {onboarding.error ?? onboarding.attention ?? (onboarding.checking ? "Checking for drift…" : onboarding.lastCheck?.status === "clean" ? "Last check found no drift." : onboarding.lastCheck?.status === "drift" ? `${onboarding.lastCheck.total ?? "Some"} differences in drift-report.md.` : "Your first check is running.")}
            </p>
          </div>
        </Card>
      </section>}

      {onboarding?.running && <ProjectControls runtime={onboarding} onChanged={() => { void fetchConfig(); }} />}

      <section aria-labelledby="slack-heading">
        <h2
          id="slack-heading"
          className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground"
        >
          Slack
        </h2>
        <Card className="mb-5 gap-0 rounded-2xl border-[0.5px] border-border bg-card shadow-none before:hidden">
          <div className="flex items-center gap-2.5 px-3.5 py-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white ring-1 ring-black/5 dark:ring-white/10">
              <img
                src="https://a.slack-edge.com/80588/marketing/img/icons/icon_slack_hash_colored.png"
                alt=""
                width={24}
                height={24}
                className="size-6"
              />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium leading-[1.55]">
                {slackTitle}
              </p>
              <p className="text-[12px] leading-[1.55] text-muted-foreground">
                {slackSub}
              </p>
            </div>
            {slack.connected && <Button variant="ghost" size="sm" className="h-7 shrink-0 rounded-lg px-2 text-xs shadow-none sm:text-xs" loading={saving === "test"} disabled={unavailable || busy} onClick={() => { void handleTestSlack(); }}>Test</Button>}
            {slack.connected ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 shrink-0 rounded-lg border-[0.5px] px-2.5 text-xs shadow-none sm:text-xs"
                loading={saving === "disconnect"}
                disabled={unavailable || busy}
                onClick={() => {
                  void handleDisconnectSlack();
                }}
              >
                Disconnect
              </Button>
            ) : (
              <Button
                size="sm"
                className="h-7 shrink-0 rounded-lg px-3 text-xs shadow-none sm:text-xs"
                loading={saving === "connect"}
                disabled={unavailable || busy}
                onClick={() => {
                  void handleConnectSlack();
                }}
              >
                Connect
              </Button>
            )}
          </div>
        </Card>
      </section>

      <section aria-labelledby="notifications-heading">
        <h2
          id="notifications-heading"
          className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground"
        >
          Notifications
        </h2>
        <Card className="mb-5 gap-0 rounded-2xl border-[0.5px] border-border bg-card shadow-none before:hidden">
          <div className="flex items-center gap-2.5 px-3.5 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium leading-[1.55]">
                Notify on drift
              </p>
              <p className="text-[12px] leading-[1.55] text-muted-foreground">
                Master switch for Slack messages
              </p>
            </div>
            <Switch
              checked={notify.enabled}
              disabled={unavailable || busy}
              onCheckedChange={(checked) => {
                void handleNotifyToggle(checked);
              }}
              className="h-5 w-9 shrink-0 p-[2px] [--thumb-size:--spacing(4)]"
              thumbClassName="data-checked:translate-x-4"
              aria-label="Notify on drift"
            />
          </div>
          <div className="flex items-center gap-2.5 border-t-[0.5px] border-border px-3.5 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium leading-[1.55]">
                Only when counts changed
              </p>
              <p className="text-[12px] leading-[1.55] text-muted-foreground">
                Off notifies after every run
              </p>
            </div>
            <Switch
              checked={notify.onlyOnChange}
              disabled={onlyOnChangeDisabled}
              onCheckedChange={(checked) => {
                void handleOnlyOnChangeToggle(checked);
              }}
              className="h-5 w-9 shrink-0 p-[2px] [--thumb-size:--spacing(4)]"
              thumbClassName="data-checked:translate-x-4"
              aria-label="Only notify when counts changed"
            />
          </div>
        </Card>
      </section>

      {notify.enabled && !slack.connected && !loading && (
        <p className="mb-3 text-[11.5px] leading-[1.55] text-warning">
          Slack isn&apos;t connected, so drift notifications can&apos;t be
          delivered.
        </p>
      )}

      <p className="mb-6 text-[11.5px] leading-[1.55] text-faint">
        Overdue deprecations count as drift. Alerts follow these notification preferences.
      </p>

      <SupportFooter />

      {toast && (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-5">
          <div
            role={toast.tone === "error" ? "alert" : "status"}
            aria-live={toast.tone === "error" ? "assertive" : "polite"}
            className="toast-in pointer-events-auto flex w-max max-w-full items-start gap-2 rounded-xl border-[0.5px] border-border bg-card px-3 py-2 text-left text-[12px] leading-[1.55] text-card-foreground shadow-lg"
          >
            {toast.tone === "success" ? (
              <CircleCheck
                className="mt-[1px] size-3.5 shrink-0 text-success"
                aria-hidden="true"
              />
            ) : toast.tone === "error" ? (
              <CircleAlert
                className="mt-[1px] size-3.5 shrink-0 text-destructive"
                aria-hidden="true"
              />
            ) : (
              <Info
                className="mt-[1px] size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            )}
            <p className="min-w-0 max-w-[300px]">{toast.message}</p>
            {toast.retry && (
              <button
                type="button"
                className="shrink-0 rounded font-medium text-foreground underline-offset-2 hover:underline"
                onClick={() => {
                  setToast(null);
                  void fetchConfig();
                }}
              >
                Retry
              </button>
            )}
            <button
              type="button"
              aria-label="Dismiss notification"
              className="-mr-1 -mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
              onClick={() => setToast(null)}
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
