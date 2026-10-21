import { CircleAlert, Plug, Send } from "@/components/icons";
import * as React from "react";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import { useApi } from "@/lib/api-context";
import { errorMessage, formatRelative } from "@/lib/format";
import type {
  ConnectionType,
  ConnectionView,
  NotificationMode,
  NotificationRules,
} from "@/lib/types";
import { useQuery } from "@/lib/use-query";

const STATUS_META: Record<
  ConnectionView["status"],
  { label: string; variant: "success" | "info" | "secondary" | "error" }
> = {
  configured: { label: "Connected", variant: "success" },
  bound: { label: "Link saved", variant: "info" },
  unconfigured: { label: "Not connected", variant: "secondary" },
  error: { label: "Error", variant: "error" },
};

function StatusBadge({
  status,
}: {
  status: ConnectionView["status"];
}): React.ReactElement {
  const meta = STATUS_META[status];
  return (
    <Badge size="sm" variant={meta.variant}>
      {meta.label}
    </Badge>
  );
}

function useSaveConnection(
  projectId: string,
  type: ConnectionType,
  onSaved: () => void,
): {
  save: (payload: Record<string, string>) => Promise<void>;
  saving: boolean;
} {
  const api = useApi();
  const [saving, setSaving] = React.useState(false);
  async function save(payload: Record<string, string>): Promise<void> {
    if (saving) return;
    setSaving(true);
    try {
      await api.put(`/projects/${projectId}/connections/${type}`, payload);
      toastManager.add({
        description:
          type === "figma"
            ? "Figma binding saved."
            : "Slack is connected.",
        title: "Connection saved",
        type: "success",
      });
      onSaved();
    } catch (cause) {
      toastManager.add({
        description: errorMessage(cause),
        title: "Could not save the connection",
        type: "error",
      });
    } finally {
      setSaving(false);
    }
  }
  return { save, saving };
}

function DisconnectButton({
  projectId,
  type,
  onCleared,
  label,
}: {
  projectId: string;
  type: ConnectionType;
  onCleared: () => void;
  label: string;
}): React.ReactElement {
  const api = useApi();
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);

  async function clear(): Promise<void> {
    if (pending) return;
    setPending(true);
    try {
      await api.del(`/projects/${projectId}/connections/${type}`);
      toastManager.add({
        description: "The binding and its stored secret were removed.",
        title: "Disconnected",
        type: "success",
      });
      setOpen(false);
      onCleared();
    } catch (cause) {
      toastManager.add({
        description: errorMessage(cause),
        title: "Could not disconnect",
        type: "error",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      <AlertDialogTrigger
        render={
          <Button type="button" size="sm" variant="ghost">
            {label}
          </Button>
        }
      />
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect {type}?</AlertDialogTitle>
          <AlertDialogDescription>
            The stored secret is cleared. Snapshots already received are
            untouched.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button type="button" variant="outline" />}>
            Cancel
          </AlertDialogClose>
          <Button
            disabled={pending}
            onClick={() => void clear()}
            variant="destructive"
          >
            {pending ? "Disconnecting…" : "Disconnect"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function figmaFileUrl(fileKey: string | null): string {
  return fileKey ? `https://www.figma.com/file/${fileKey}` : "";
}

function FigmaSection({
  projectId,
  connection,
  onSaved,
}: {
  projectId: string;
  connection: ConnectionView;
  onSaved: () => void;
}): React.ReactElement {
  const currentUrl = React.useMemo(
    () => figmaFileUrl(connection.fileKey),
    [connection.fileKey],
  );
  const [figmaUrl, setFigmaUrl] = React.useState(currentUrl);
  const [secret, setSecret] = React.useState("");
  const { save, saving } = useSaveConnection(projectId, "figma", () => {
    setSecret("");
    onSaved();
  });

  React.useEffect(() => {
    setFigmaUrl(currentUrl);
  }, [currentUrl]);

  const changed = figmaUrl !== currentUrl || secret.trim() !== "";
  const needsUrl = secret.trim() !== "" && !figmaUrl.trim();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Plug className="size-4 text-muted-foreground" />
            <span className="font-medium text-sm">Figma</span>
            <StatusBadge status={connection.status} />
          </div>
          <p className="mt-1 text-muted-foreground text-[13px]">
            {connection.fileName ??
              "Paste the file URL — the key and name are read from it."}
          </p>
        </div>
        {connection.status !== "unconfigured" ? (
          <DisconnectButton
            label="Disconnect"
            onCleared={onSaved}
            projectId={projectId}
            type="figma"
          />
        ) : null}
      </div>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const payload: Record<string, string> = {};
          if (figmaUrl !== currentUrl) payload.figmaUrl = figmaUrl.trim();
          if (secret.trim()) payload.secret = secret.trim();
          if (Object.keys(payload).length === 0) return;
          void save(payload);
        }}
      >
        <Field>
          <FieldLabel>Figma project</FieldLabel>
          <Input
            onChange={(event) => setFigmaUrl(event.target.value)}
            placeholder="https://www.figma.com/design/…"
            value={figmaUrl}
          />
        </Field>
        <Field>
          <FieldLabel>Figma API key</FieldLabel>
          <Input
            autoComplete="off"
            onChange={(event) => setSecret(event.target.value)}
            placeholder={
              connection.secretTail
                ? `Stored ${connection.secretTail} — type to replace`
                : "figd_…"
            }
            type="password"
            value={secret}
          />
          <FieldDescription>
            Write-only. Used to poll the file and keep its name current.
          </FieldDescription>
        </Field>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground text-[13px]">
            {connection.updatedAt
              ? `Updated ${formatRelative(connection.updatedAt)}`
              : "No token stored yet"}
          </span>
          <Button disabled={!changed || needsUrl || saving} type="submit">
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function slackFailureDetail(cause: unknown): string | null {
  if (cause instanceof ApiError && cause.details && typeof cause.details === "object") {
    const detail = (cause.details as Record<string, unknown>).detail;
    if (typeof detail === "string" && detail) return detail;
  }
  return null;
}

function NotificationRulesSection({
  projectId,
}: {
  projectId: string;
}): React.ReactElement {
  const api = useApi();
  const query = useQuery<{ rules: NotificationRules }>(
    () => api.get(`/projects/${projectId}/notification-rules`),
    [projectId],
  );
  const [saving, setSaving] = React.useState(false);

  async function save(payload: Partial<NotificationRules>): Promise<void> {
    if (saving) return;
    setSaving(true);
    try {
      await api.put(`/projects/${projectId}/notification-rules`, payload);
      toastManager.add({
        description: "Future digests follow the new rules.",
        title: "Notification rules saved",
        type: "success",
      });
      query.reload();
    } catch (cause) {
      toastManager.add({
        description: errorMessage(cause),
        title: "Could not save the rules",
        type: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  const rules = query.data?.rules ?? null;

  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      <div className="text-muted-foreground text-[13px]">
        When the notify job posts drift digests to this channel.
      </div>
      {rules === null ? (
        query.error ? (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">{query.error}</span>
            <Button onClick={query.reload} size="sm" variant="outline">
              Retry
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Spinner className="size-4" />
            Loading rules…
          </div>
        )
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm">Send a digest</div>
              <div className="text-muted-foreground text-[13px]">
                “Only on changes” stays quiet while everything is in sync.
              </div>
            </div>
            <Select
              disabled={saving}
              onValueChange={(value) =>
                void save({ mode: value as NotificationMode })
              }
              value={rules.mode}
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="change">Only on changes</SelectItem>
                <SelectItem value="always">Whenever checked</SelectItem>
                <SelectItem value="never">Never</SelectItem>
              </SelectPopup>
            </Select>
          </div>
          <label className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm">Overdue deprecations bypass “never”</div>
              <div className="text-muted-foreground text-[13px]">
                A passed deadline always pings, even when digests are off.
              </div>
            </div>
            <Switch
              checked={rules.overdueAlways}
              disabled={saving}
              onCheckedChange={(checked) => void save({ overdueAlways: checked })}
            />
          </label>
        </>
      )}
    </div>
  );
}

function SlackSection({
  projectId,
  connection,
  slackConfigured,
  onSaved,
}: {
  projectId: string;
  connection: ConnectionView;
  slackConfigured: boolean;
  onSaved: () => void;
}): React.ReactElement {
  const api = useApi();
  const [busy, setBusy] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const enabled = connection.status !== "unconfigured";

  async function install(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.get<{ url: string }>(
        `/projects/${projectId}/connections/slack/install`,
      );
      window.location.assign(result.url);
    } catch (cause) {
      toastManager.add({
        description: errorMessage(cause),
        title: "Could not open Slack",
        type: "error",
      });
      setBusy(false);
    }
  }

  async function disable(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await api.del(`/projects/${projectId}/connections/slack`);
      toastManager.add({
        description: "Drift digests will no longer post to Slack.",
        title: "Slack disconnected",
        type: "success",
      });
      onSaved();
    } catch (cause) {
      toastManager.add({
        description: errorMessage(cause),
        title: "Could not disconnect Slack",
        type: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  async function test(): Promise<void> {
    if (testing) return;
    setTesting(true);
    try {
      await api.post(`/projects/${projectId}/connections/slack/test`);
      toastManager.add({
        description: "Check the channel — the message should be there.",
        title: "Test message sent",
        type: "success",
      });
      onSaved();
    } catch (cause) {
      toastManager.add({
        description: slackFailureDetail(cause) ?? errorMessage(cause),
        title: "Slack refused the test message",
        type: "error",
      });
      onSaved();
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Send className="size-4 text-muted-foreground" />
            <span className="font-medium text-sm">Slack</span>
            {enabled ? <StatusBadge status={connection.status} /> : null}
          </div>
          <p className="mt-1 text-muted-foreground text-[13px]">
            {enabled
              ? `${connection.teamName ?? "Slack"}${connection.channelName ? ` · #${connection.channelName.replace(/^#/, "")}` : ""} — drift digests post here.`
              : "Add the elf bot to a channel; Slack returns a webhook for digests."}
          </p>
        </div>
        <Switch
          checked={enabled}
          disabled={busy || (!enabled && !slackConfigured)}
          onCheckedChange={(checked) => {
            if (checked) void install();
            else void disable();
          }}
        />
      </div>

      {!slackConfigured ? (
        <p className="text-muted-foreground text-[13px]">
          Slack is not configured on this server yet — set SLACK_CLIENT_ID and
          SLACK_CLIENT_SECRET to enable the switch.
        </p>
      ) : null}

      {connection.status === "error" && connection.statusMessage ? (
        <Alert variant="error">
          <CircleAlert />
          <AlertTitle>The last Slack delivery failed</AlertTitle>
          <AlertDescription>{connection.statusMessage}</AlertDescription>
        </Alert>
      ) : null}

      {enabled ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground text-[13px]">
              {connection.updatedAt
                ? `Connected ${formatRelative(connection.updatedAt)}`
                : "Connected"}
            </span>
            <div className="flex items-center gap-2">
              <DisconnectButton
                label="Disconnect"
                onCleared={onSaved}
                projectId={projectId}
                type="slack"
              />
              <Button
                disabled={testing}
                onClick={() => void test()}
                size="sm"
                type="button"
                variant="outline"
              >
                <Send />
                {testing ? "Sending…" : "Send test"}
              </Button>
            </div>
          </div>
          <NotificationRulesSection projectId={projectId} />
        </>
      ) : null}
    </div>
  );
}

export function ProjectIntegrations({
  projectId,
  projectName,
  slackConfigured,
}: {
  projectId: string;
  projectName: string;
  slackConfigured: boolean;
}): React.ReactElement {
  const api = useApi();
  const query = useQuery<{ connections: ConnectionView[] }>(
    () => api.get(`/projects/${projectId}/connections`),
    [projectId],
  );
  const figma =
    query.data?.connections.find((entry) => entry.type === "figma") ?? null;
  const slack =
    query.data?.connections.find((entry) => entry.type === "slack") ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{projectName}</CardTitle>
        <CardDescription>
          Figma file and Slack digests for this project.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {query.loading && !query.data ? (
          <div className="flex items-center gap-2 py-2 text-muted-foreground text-sm">
            <Spinner className="size-4" />
            Loading integrations…
          </div>
        ) : query.error || !query.data || !figma || !slack ? (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">
              {query.error ?? "Could not load integrations."}
            </span>
            <Button onClick={query.reload} size="sm" variant="outline">
              Retry
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <FigmaSection
              connection={figma}
              onSaved={query.reload}
              projectId={projectId}
            />
            <div className="border-t" />
            <SlackSection
              connection={slack}
              onSaved={query.reload}
              projectId={projectId}
              slackConfigured={slackConfigured}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
