import { CircleAlert, Plug, Send } from "@/components/icons";
import * as React from "react";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  configured: { label: "Configured", variant: "success" },
  bound: { label: "Bound", variant: "info" },
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
            : "Slack webhook saved — send a test to verify it.",
        title: "Connection saved",
        type: "success",
      });
      onSaved();
    } catch (cause) {
      toastManager.add({
        description:
          cause instanceof Error ? cause.message : "Something went wrong.",
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
        description:
          cause instanceof Error ? cause.message : "Something went wrong.",
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
          <Button type="button" variant="ghost">
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

function FigmaPanel({
  projectId,
  connection,
  onSaved,
}: {
  projectId: string;
  connection: ConnectionView;
  onSaved: () => void;
}): React.ReactElement {
  const [fileKey, setFileKey] = React.useState(connection.fileKey ?? "");
  const [fileName, setFileName] = React.useState(connection.fileName ?? "");
  const [secret, setSecret] = React.useState("");
  const { save, saving } = useSaveConnection(projectId, "figma", () => {
    setSecret("");
    onSaved();
  });

  const changed =
    fileKey !== (connection.fileKey ?? "") ||
    fileName !== (connection.fileName ?? "") ||
    secret.trim() !== "";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Figma</CardTitle>
        <CardDescription>
          Where the Figma side of the truth lives. The console polls the file
          every 15 minutes for version changes.
        </CardDescription>
        <CardAction>
          <StatusBadge status={connection.status} />
        </CardAction>
      </CardHeader>
      <CardContent>
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          const payload: Record<string, string> = {};
          if (fileKey !== (connection.fileKey ?? "")) payload.fileKey = fileKey;
          if (fileName !== (connection.fileName ?? "")) payload.fileName = fileName;
          if (secret.trim()) payload.secret = secret.trim();
          void save(payload);
        }}
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <Field>
            <FieldLabel>File key</FieldLabel>
            <Input
              onChange={(event) => setFileKey(event.target.value)}
              placeholder="LdPj1u7FVRkCqAr6O9MnHf"
              value={fileKey}
            />
            <FieldDescription>
              The segment after /design/ in the Figma file URL.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel>File name</FieldLabel>
            <Input
              onChange={(event) => setFileName(event.target.value)}
              placeholder="Design system"
              value={fileName}
            />
            <FieldDescription>Optional, for display.</FieldDescription>
          </Field>
        </div>
        <Field>
          <FieldLabel>Figma API token</FieldLabel>
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
            Write-only: sealed with AES-GCM, never returned by the API.
          </FieldDescription>
        </Field>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground text-[13px]">
            {connection.updatedAt
              ? `Updated ${formatRelative(connection.updatedAt)}`
              : "No secret stored yet"}
          </span>
          <div className="flex items-center gap-2">
            {connection.status !== "unconfigured" ? (
              <DisconnectButton
                label="Disconnect"
                onCleared={onSaved}
                projectId={projectId}
                type="figma"
              />
            ) : null}
            <Button disabled={!changed || saving} type="submit">
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </form>
      </CardContent>
    </Card>
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
    <div className="flex flex-col gap-4 border-t pt-5">
      <div>
        <div className="font-heading font-medium text-sm">Notifications</div>
        <div className="mt-0.5 text-muted-foreground text-[13px]">
          When the notify job posts drift digests to this webhook.
        </div>
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

function SlackPanel({
  projectId,
  connection,
  onSaved,
}: {
  projectId: string;
  connection: ConnectionView;
  onSaved: () => void;
}): React.ReactElement {
  const api = useApi();
  const [secret, setSecret] = React.useState("");
  const [testing, setTesting] = React.useState(false);
  const { save, saving } = useSaveConnection(projectId, "slack", () => {
    setSecret("");
    onSaved();
  });

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
    <Card>
      <CardHeader>
        <CardTitle>Slack</CardTitle>
        <CardDescription>
          Where drift digests land — verify the webhook, then tune when it
          fires.
        </CardDescription>
        <CardAction>
          <StatusBadge status={connection.status} />
        </CardAction>
      </CardHeader>
      <CardContent>
      <div className="flex flex-col gap-5">
        {connection.status === "error" && connection.statusMessage ? (
          <Alert variant="error">
            <CircleAlert />
            <AlertTitle>The last Slack delivery failed</AlertTitle>
            <AlertDescription>{connection.statusMessage}</AlertDescription>
          </Alert>
        ) : null}
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!secret.trim()) return;
            void save({ secret: secret.trim() });
          }}
        >
          <Field>
            <FieldLabel>Webhook URL</FieldLabel>
            <Input
              autoComplete="off"
              onChange={(event) => setSecret(event.target.value)}
              placeholder={
                connection.secretTail
                  ? `Stored ${connection.secretTail} — paste to replace`
                  : "https://hooks.slack.com/services/…"
              }
              type="password"
              value={secret}
            />
            <FieldDescription>
              Write-only: sealed with AES-GCM, never returned by the API.
            </FieldDescription>
          </Field>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground text-[13px]">
              {connection.updatedAt
                ? `Updated ${formatRelative(connection.updatedAt)}`
                : "No webhook stored yet"}
            </span>
            <div className="flex items-center gap-2">
              {connection.status !== "unconfigured" ? (
                <DisconnectButton
                  label="Disconnect"
                  onCleared={onSaved}
                  projectId={projectId}
                  type="slack"
                />
              ) : null}
              {connection.status !== "unconfigured" ? (
                <Button
                  disabled={testing}
                  onClick={() => void test()}
                  type="button"
                  variant="outline"
                >
                  <Send />
                  {testing ? "Sending…" : "Send test"}
                </Button>
              ) : null}
              <Button disabled={!secret.trim() || saving} type="submit">
                {saving ? "Saving…" : "Save webhook"}
              </Button>
            </div>
          </div>
        </form>
        <NotificationRulesSection projectId={projectId} />
      </div>
      </CardContent>
    </Card>
  );
}

export function ConnectionsScreen({
  projectId,
}: {
  projectId: string;
}): React.ReactElement {
  const api = useApi();
  const query = useQuery<{ connections: ConnectionView[] }>(
    () => api.get(`/projects/${projectId}/connections`),
    [projectId],
  );

  if (query.loading && !query.data) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Spinner className="size-4" />
        Loading connections…
      </div>
    );
  }

  if (query.error || !query.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Could not load connections</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">{query.error}</span>
            <Button onClick={query.reload} size="sm" variant="outline">
              Retry
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const figma = query.data.connections.find(
    (connection) => connection.type === "figma",
  );
  const slack = query.data.connections.find(
    (connection) => connection.type === "slack",
  );

  return (
    <div className="flex flex-col gap-6">
      <p className="flex items-center gap-2 text-muted-foreground text-sm">
        <Plug className="size-4" />
        Bind the sources for this project. Secrets are write-only.
      </p>
      {figma ? (
        <FigmaPanel
          connection={figma}
          key={`figma-${figma.updatedAt ?? "new"}`}
          onSaved={query.reload}
          projectId={projectId}
        />
      ) : null}
      {slack ? (
        <SlackPanel
          connection={slack}
          key={`slack-${slack.updatedAt ?? "new"}`}
          onSaved={query.reload}
          projectId={projectId}
        />
      ) : null}
    </div>
  );
}
