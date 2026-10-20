import {
  Archive,
  Bell,
  Box,
  KeyRound,
  Plug,
  Send,
  Sparkles,
} from "@/components/icons";
import * as React from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { useApi } from "@/lib/api-context";
import { errorMessage, formatRelative } from "@/lib/format";
import type { ActivityEntry, ActivityResponse } from "@/lib/types";

const PAGE_SIZE = 50;

interface ActionMeta {
  icon: React.ComponentType<{ className?: string }>;
  sentence: (detail: Record<string, unknown> | null) => string;
}

function text(detail: Record<string, unknown> | null, key: string): string | null {
  const value = detail?.[key];
  return typeof value === "string" ? value : null;
}

const ACTION_META: Record<string, ActionMeta> = {
  "project.create": {
    icon: Box,
    sentence: (detail) => `created the project “${text(detail, "name") ?? "—"}”`,
  },
  "deprecation.create": {
    icon: Archive,
    sentence: (detail) =>
      `added the deprecation “${text(detail, "name") ?? "—"}” (${text(detail, "type") ?? "token"})`,
  },
  "deprecation.update": {
    icon: Archive,
    sentence: () => "edited a deprecation",
  },
  "deprecation.delete": {
    icon: Archive,
    sentence: () => "removed a deprecation",
  },
  "connection.update": {
    icon: Plug,
    sentence: (detail) => `updated the ${text(detail, "type") ?? "connection"} connection`,
  },
  "connection.clear": {
    icon: Plug,
    sentence: (detail) => `disconnected ${text(detail, "type") ?? "a connection"}`,
  },
  "notifications.update": {
    icon: Bell,
    sentence: (detail) => `set Slack notifications to “${text(detail, "mode") ?? "—"}”`,
  },
  "slack.test": {
    icon: Send,
    sentence: () => "sent a Slack test message",
  },
  "token.issue": {
    icon: KeyRound,
    sentence: (detail) =>
      `issued a ${text(detail, "kind") ?? "—"} token (…${text(detail, "last4") ?? "????"})`,
  },
  "token.revoke": {
    icon: KeyRound,
    sentence: () => "revoked a token",
  },
};

function shortActor(actor: string): string {
  if (actor.length <= 16) return actor;
  return `${actor.slice(0, 12)}…`;
}

function ActivityRow({ entry }: { entry: ActivityEntry }): React.ReactElement {
  const meta = ACTION_META[entry.action];
  const Icon = meta?.icon ?? Sparkles;
  const sentence = meta?.sentence(entry.detail) ?? entry.action.replace(/\./g, " ");
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm">
          <span className="text-muted-foreground">{shortActor(entry.actor)}</span>{" "}
          {sentence}
          {entry.project ? (
            <>
              {" · "}
              <a
                className="text-primary underline-offset-2 hover:underline"
                href={`#/p/${encodeURIComponent(entry.project.id)}`}
              >
                {entry.project.name}
              </a>
            </>
          ) : null}
        </p>
        <p className="mt-0.5 text-muted-foreground text-[13px]">
          {formatRelative(entry.createdAt)}
        </p>
      </div>
    </li>
  );
}

export function ActivityScreen(): React.ReactElement {
  const api = useApi();
  const [entries, setEntries] = React.useState<ActivityEntry[] | null>(null);
  const [hasMore, setHasMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);

  const load = React.useCallback(
    async (before?: string): Promise<void> => {
      try {
        const query = before
          ? `?limit=${PAGE_SIZE}&before=${encodeURIComponent(before)}`
          : `?limit=${PAGE_SIZE}`;
        const page = await api.get<ActivityResponse>(`/activity${query}`);
        setEntries((current) => (before && current ? [...current, ...page.entries] : page.entries));
        setHasMore(page.hasMore);
        setError(null);
      } catch (cause) {
        setError(errorMessage(cause));
      }
    },
    [api],
  );

  React.useEffect(() => {
    void load();
  }, [load]);

  if (entries === null && error === null) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Spinner className="size-4" />
        Loading activity…
      </div>
    );
  }

  if (entries === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Could not load activity</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">{error}</span>
            <Button onClick={() => void load()} size="sm" variant="outline">
              Retry
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading font-semibold text-lg">Activity</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          Who changed what in this workspace — secrets never land here.
        </p>
      </div>
      <Card>
        {entries.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Sparkles />
              </EmptyMedia>
              <EmptyTitle>Nothing yet</EmptyTitle>
              <EmptyDescription>
                Creating projects, editing deprecations and issuing tokens all show up here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="divide-y divide-border">
            {entries.map((entry) => (
              <ActivityRow entry={entry} key={entry.id} />
            ))}
          </ul>
        )}
      </Card>
      {hasMore ? (
        <div className="flex justify-center">
          <Button
            disabled={loadingMore}
            onClick={() => {
              const last = entries.at(-1);
              if (!last || loadingMore) return;
              setLoadingMore(true);
              void load(last.createdAt).finally(() => setLoadingMore(false));
            }}
            variant="outline"
          >
            {loadingMore ? "Loading…" : "Load older entries"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
