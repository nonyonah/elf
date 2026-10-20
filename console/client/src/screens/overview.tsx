import { Boxes, Plus } from "@/components/icons";
import * as React from "react";
import { StatCard } from "@/components/stat-card";
import { StatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFrame,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toastManager } from "@/components/ui/toast";
import { useApi } from "@/lib/api-context";
import {
  formatDate,
  formatDateTime,
  formatDayLabel,
  formatNumber,
  formatRelative,
  totalDriftCounts,
} from "@/lib/format";
import { navigate } from "@/lib/router";
import type { OverviewResponse } from "@/lib/types";
import { TrendChart } from "@/components/trend-chart";

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function CreateProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: { id: string; name: string }) => void;
}): React.ReactElement {
  const api = useApi();
  const [name, setName] = React.useState("");
  const [pending, setPending] = React.useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    setPending(true);
    try {
      const result = await api.post<{ project: { id: string; name: string } }>(
        "/projects",
        { name: trimmed },
      );
      toastManager.add({
        description: `${result.project.name} is ready for its first push.`,
        title: "Project created",
        type: "success",
      });
      setName("");
      onOpenChange(false);
      onCreated(result.project);
    } catch (cause) {
      toastManager.add({
        description:
          cause instanceof Error ? cause.message : "Something went wrong.",
        title: "Could not create the project",
        type: "error",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            A project groups the code and Figma sources that should stay in
            sync.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <DialogPanel>
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input
                autoFocus
                maxLength={60}
                onChange={(event) => setName(event.target.value)}
                placeholder="Marketing site"
                value={name}
              />
            </Field>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancel
            </DialogClose>
            <Button disabled={pending || !name.trim()} type="submit">
              {pending ? "Creating…" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export function OverviewScreen({
  overview,
  reloadOverview,
}: {
  overview: OverviewResponse;
  reloadOverview: () => void;
}): React.ReactElement {
  const [createOpen, setCreateOpen] = React.useState(false);
  const projects = overview.projects;

  const trendPoints = overview.trend.map((point) => ({
    label: formatDayLabel(point.date),
    tooltip: formatDate(`${point.date}T12:00:00`),
    value: point.total,
  }));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading font-semibold text-xl tracking-tight">
            {greeting()}
          </h1>
          <p className="mt-0.5 text-muted-foreground text-sm">
            Here&apos;s what&apos;s happening across your projects.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus />
          New project
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          hint={`${overview.summary.ok} in sync`}
          label="Projects"
          value={formatNumber(overview.summary.total)}
        />
        <StatCard
          hint={
            overview.summary.drift === 0
              ? "Everything matches"
              : "Needs a look"
          }
          label="In drift"
          tone={overview.summary.drift > 0 ? "error" : "success"}
          value={formatNumber(overview.summary.drift)}
        />
        <StatCard
          hint={
            overview.summary.lastCheckedAt
              ? formatDateTime(overview.summary.lastCheckedAt)
              : "No checks yet"
          }
          label="Last checked"
          value={formatRelative(overview.summary.lastCheckedAt)}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Drift over time</CardTitle>
          <CardDescription>
            Drift items across all projects — the last run of each project per
            day.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TrendChart
            emptyText="No drift runs yet — push a snapshot with elf push to get started."
            points={trendPoints}
          />
        </CardContent>
      </Card>

      {overview.projects.length === 0 ? (
        <Card>
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Boxes />
              </EmptyMedia>
              <EmptyTitle>No projects yet</EmptyTitle>
              <EmptyDescription>
                Create a project, then push your first snapshot with elf push.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => setCreateOpen(true)}>
                <Plus />
                New project
              </Button>
            </EmptyContent>
          </Empty>
        </Card>
      ) : (
        <>
          <CardFrame>
          <Table variant="card">
            <TableHeader>
              <TableRow>
                <TableHead>Project</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Drift</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Components</TableHead>
                <TableHead className="text-right">Last activity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.map((project) => {
                const drift = totalDriftCounts(project.counts);
                return (
                  <TableRow
                    className="cursor-pointer"
                    key={project.id}
                    onClick={() =>
                      navigate({
                        name: "project",
                        projectId: project.id,
                        view: "overview",
                      })
                    }
                  >
                    <TableCell>
                      <div className="font-medium">{project.name}</div>
                      <div className="text-[13px] text-muted-foreground">
                        {project.slug}
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusPill size="sm" state={project.state} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {drift === 0 ? (
                        <span className="text-muted-foreground">0</span>
                      ) : (
                        drift
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {project.tokenCounts
                        ? `${project.tokenCounts.figma} → ${project.tokenCounts.code}`
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {project.componentCount ?? "—"}
                    </TableCell>
                    <TableCell
                      className="text-right text-muted-foreground"
                      title={formatDateTime(project.lastActivity)}
                    >
                      {formatRelative(project.lastActivity)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          </CardFrame>
        </>
      )}

      <CreateProjectDialog
        onCreated={(project) => {
          reloadOverview();
          navigate({
            name: "project",
            projectId: project.id,
            view: "overview",
          });
        }}
        onOpenChange={setCreateOpen}
        open={createOpen}
      />
    </div>
  );
}
