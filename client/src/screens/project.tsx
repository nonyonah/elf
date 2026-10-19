import { CircleAlert, GitBranch, TriangleAlert } from "lucide-react";
import * as React from "react";
import { Panel } from "@/components/panel";
import { StatCard } from "@/components/stat-card";
import { stateLabel, StatusPill } from "@/components/status-pill";
import { TrendChart } from "@/components/trend-chart";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { useApi } from "@/lib/api-context";
import {
  formatDate,
  formatDateTime,
  formatRelative,
  isColorValue,
  shortCommit,
  totalDriftCounts,
} from "@/lib/format";
import { navigate, type ProjectView } from "@/lib/router";
import type {
  ComponentIssue,
  DriftResult,
  ProjectDetailResponse,
  Token,
} from "@/lib/types";
import { useQuery } from "@/lib/use-query";
import { ConnectionsScreen } from "./connections";
import { DeprecationsScreen } from "./deprecations";

type ViewMode = "designer" | "developer";

const VIEW_MODE_KEY = "elf-console:project-view";

function useViewMode(): [ViewMode, (mode: ViewMode) => void] {
  const [mode, setMode] = React.useState<ViewMode>(() =>
    window.localStorage.getItem(VIEW_MODE_KEY) === "developer"
      ? "developer"
      : "designer",
  );
  React.useEffect(() => {
    window.localStorage.setItem(VIEW_MODE_KEY, mode);
  }, [mode]);
  return [mode, setMode];
}

function ColorValue({ value }: { value: string }): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-2">
      {isColorValue(value) ? (
        <span
          aria-hidden="true"
          className="size-4 shrink-0 rounded-[.25rem] border shadow-xs"
          style={{ backgroundColor: value }}
        />
      ) : null}
      <code className="font-mono text-xs">{value}</code>
    </span>
  );
}

function CategoryBadge({ category }: { category: string }): React.ReactElement {
  return (
    <Badge size="sm" variant="secondary">
      {category}
    </Badge>
  );
}

function EmptyRow({
  colSpan,
  children,
}: {
  colSpan: number;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <TableRow>
      <TableCell className="text-muted-foreground" colSpan={colSpan}>
        {children}
      </TableCell>
    </TableRow>
  );
}

function ValueMismatchTable({
  details,
}: {
  details: DriftResult;
}): React.ReactElement {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Token</TableHead>
          <TableHead>Category</TableHead>
          <TableHead>Figma</TableHead>
          <TableHead>Code</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {details.valueMismatches.length === 0 ? (
          <EmptyRow colSpan={4}>No value mismatches.</EmptyRow>
        ) : null}
        {details.valueMismatches.map((mismatch) => (
          <TableRow key={`${mismatch.name}-${mismatch.mode ?? ""}`}>
            <TableCell>
              <span className="font-medium">{mismatch.name}</span>
              {mismatch.mode ? (
                <span className="ms-1.5 text-muted-foreground text-xs">
                  {mismatch.mode}
                </span>
              ) : null}
            </TableCell>
            <TableCell>
              <CategoryBadge category={mismatch.category} />
            </TableCell>
            <TableCell>
              <ColorValue value={mismatch.figmaValue} />
            </TableCell>
            <TableCell>
              <ColorValue value={mismatch.codeValue} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

interface MissingEntry {
  token: Token;
  side: "Not in code" | "Not in Figma";
}

function MissingTokensTable({
  details,
}: {
  details: DriftResult;
}): React.ReactElement {
  const entries: MissingEntry[] = [
    ...details.missingInCode.map((token): MissingEntry => ({ token, side: "Not in code" })),
    ...details.missingInFigma.map((token): MissingEntry => ({ token, side: "Not in Figma" })),
  ];
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Token</TableHead>
          <TableHead>Category</TableHead>
          <TableHead>Value</TableHead>
          <TableHead>Side</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.length === 0 ? (
          <EmptyRow colSpan={4}>No missing tokens.</EmptyRow>
        ) : null}
        {entries.map(({ token, side }) => (
          <TableRow key={`${side}-${token.name}-${token.mode ?? ""}`}>
            <TableCell>
              <span className="font-medium">{token.name}</span>
              {token.mode ? (
                <span className="ms-1.5 text-muted-foreground text-xs">
                  {token.mode}
                </span>
              ) : null}
            </TableCell>
            <TableCell>
              <CategoryBadge category={token.category} />
            </TableCell>
            <TableCell>
              <ColorValue value={token.value} />
            </TableCell>
            <TableCell>
              <Badge size="sm" variant={side === "Not in code" ? "error" : "warning"}>
                {side}
              </Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

interface IssueEntry {
  issue: ComponentIssue;
  label: string;
  variant: "error" | "warning";
}

function ComponentIssuesTable({
  details,
  mode,
}: {
  details: DriftResult;
  mode: ViewMode;
}): React.ReactElement {
  const entries: IssueEntry[] = [
    ...details.componentsOutOfDate.map((issue): IssueEntry => ({
      issue,
      label: "Changed since last sync",
      variant: "warning",
    })),
    ...details.componentsChangedInFigma.map((issue): IssueEntry => ({
      issue,
      label: "Changed in Figma",
      variant: "warning",
    })),
    ...details.componentsInCodeNotInFigma.map((issue): IssueEntry => ({
      issue,
      label: "Not in Figma",
      variant: "error",
    })),
    ...details.componentsInFigmaNotInCode.map((issue): IssueEntry => ({
      issue,
      label: "Not in code",
      variant: "error",
    })),
  ];
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Component</TableHead>
          {mode === "developer" ? <TableHead>Code key</TableHead> : null}
          <TableHead>Issue</TableHead>
          <TableHead>Detail</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.length === 0 ? (
          <EmptyRow colSpan={mode === "developer" ? 4 : 3}>
            No component issues.
          </EmptyRow>
        ) : null}
        {entries.map(({ issue, label, variant }) => (
          <TableRow key={`${label}-${issue.name}`}>
            <TableCell>
              <span className="font-medium">{issue.name}</span>
            </TableCell>
            {mode === "developer" ? (
              <TableCell>
                <code className="font-mono text-xs">
                  {issue.codeKey ?? issue.name}
                </code>
              </TableCell>
            ) : null}
            <TableCell>
              <Badge size="sm" variant={variant}>
                {label}
              </Badge>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {issue.detail ?? issue.file ?? issue.nodeId ?? "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ProjectOverview({
  detail,
  mode,
}: {
  detail: ProjectDetailResponse;
  mode: ViewMode;
}): React.ReactElement {
  const counts = detail.counts;
  const details = detail.details;
  const missingTotal = (counts.missingInCode ?? 0) + (counts.missingInFigma ?? 0);
  const componentIssues =
    (counts.componentsOutOfDate ?? 0) +
    (counts.componentsChangedInFigma ?? 0) +
    (counts.componentsInCodeNotInFigma ?? 0) +
    (counts.componentsInFigmaNotInCode ?? 0);
  const overdue = details?.deprecationOverdue.length ?? 0;

  const trendPoints = detail.trend.map((run) => ({
    label: formatDate(run.createdAt),
    tooltip: `${formatDateTime(run.createdAt)} · ${stateLabel(run.state)}`,
    value: run.total,
  }));

  const commit = shortCommit(detail.latestCode?.gitCommit);

  return (
    <div className="flex flex-col gap-6">
      {detail.detailsError ? (
        <Alert variant="error">
          <CircleAlert />
          <AlertTitle>Could not recompute drift</AlertTitle>
          <AlertDescription>{detail.detailsError}</AlertDescription>
        </Alert>
      ) : null}

      {detail.state === "stale" ? (
        <Alert variant="warning">
          <TriangleAlert />
          <AlertTitle>
            {detail.staleReason === "figma"
              ? "The Figma file changed since the last snapshot"
              : "This project's data is over 24 hours old"}
          </AlertTitle>
          <AlertDescription>
            {detail.staleReason === "figma"
              ? "Open the file with the Elf Bridge plugin to push a fresh Figma snapshot."
              : "Run `elf push` from the repo, or open the file with the Elf Bridge plugin, to refresh."}
          </AlertDescription>
        </Alert>
      ) : null}

      {overdue > 0 ? (
        <Alert variant="error">
          <CircleAlert />
          <AlertTitle>
            {overdue === 1
              ? "1 deprecation is overdue"
              : `${overdue} deprecations are overdue`}
          </AlertTitle>
          <AlertDescription>
            <span>
              Remove them from code or move the deadline in the deprecation
              list.
            </span>
            <div>
              <Button
                onClick={() =>
                  navigate({
                    name: "project",
                    projectId: detail.project.id,
                    view: "deprecations",
                  })
                }
                size="sm"
                variant="outline"
              >
                Review deprecations
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {(details?.componentsChangedInFigma.length ?? 0) > 0 ? (
        <Alert variant="warning">
          <TriangleAlert />
          <AlertTitle>
            Figma changed for {details?.componentsChangedInFigma.length}{" "}
            {details?.componentsChangedInFigma.length === 1
              ? "component"
              : "components"}
          </AlertTitle>
          <AlertDescription>
            Re-sync the affected components and push a fresh snapshot.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground text-xs">
        <span>
          Code snapshot{" "}
          {detail.latestCode
            ? formatRelative(detail.latestCode.receivedAt)
            : "not pushed yet"}
        </span>
        {mode === "developer" &&
        (detail.latestCode?.gitBranch || commit) ? (
          <Badge size="sm" variant="outline">
            <GitBranch />
            {detail.latestCode?.gitBranch ?? "detached"}
            {commit ? ` · ${commit}` : ""}
          </Badge>
        ) : null}
        <span>
          Figma snapshot{" "}
          {detail.latestFigma
            ? formatRelative(detail.latestFigma.receivedAt)
            : "not received yet"}
        </span>
        {detail.fileKey ? (
          <Badge size="sm" variant="outline">
            Figma {detail.fileName ?? detail.fileKey}
          </Badge>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          hint={
            detail.latestCode
              ? `${detail.latestCode.tokenCounts.figma} in Figma`
              : "No code snapshot yet"
          }
          label="Code tokens"
          value={
            detail.latestCode
              ? detail.latestCode.tokenCounts.code
              : "—"
          }
        />
        <StatCard
          hint={counts.valueMismatches ? "Values differ" : "All values match"}
          label="Value mismatches"
          tone={counts.valueMismatches ? "error" : "default"}
          value={counts.valueMismatches ?? 0}
        />
        <StatCard
          hint={`${counts.missingInCode ?? 0} in Figma · ${counts.missingInFigma ?? 0} in code`}
          label="Missing tokens"
          tone={missingTotal > 0 ? "warning" : "default"}
          value={missingTotal}
        />
        <StatCard
          hint={`${counts.componentsOutOfDate ?? 0} changed since sync`}
          label="Component issues"
          tone={componentIssues > 0 ? "warning" : "default"}
          value={componentIssues}
        />
      </div>

      <Panel
        description="Drift items recomputed per stored run — newest on the right."
        title="Drift per run"
      >
        <TrendChart
          emptyText="No runs yet — push a snapshot with elf push to get started."
          points={trendPoints}
        />
      </Panel>

      {details ? (
        <>
          <Panel
            description="The same token name with a different value on each side."
            flush
            title="Value mismatches"
          >
            <ValueMismatchTable details={details} />
          </Panel>
          <Panel
            description="Present on one side only."
            flush
            title="Missing tokens"
          >
            <MissingTokensTable details={details} />
          </Panel>
          <Panel
            description="Components that need attention."
            flush
            title="Components"
          >
            <ComponentIssuesTable details={details} mode={mode} />
          </Panel>
        </>
      ) : (
        <Panel
          description="A code snapshot is required before drift can be computed."
          title="No snapshot to compare"
        >
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Spinner className="size-4" />
            Waiting for the first elf push from this project.
          </div>
        </Panel>
      )}
    </div>
  );
}

export function ProjectScreen({
  projectId,
  view,
}: {
  projectId: string;
  view: ProjectView;
}): React.ReactElement {
  const api = useApi();
  const [mode, setMode] = useViewMode();
  const query = useQuery<ProjectDetailResponse>(
    () => api.get(`/projects/${projectId}`),
    [projectId],
  );

  if (query.loading && !query.data) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-12 w-64" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (query.error || !query.data) {
    return (
      <Alert variant="error">
        <CircleAlert />
        <AlertTitle>Could not load this project</AlertTitle>
        <AlertDescription>
          <span>{query.error ?? "Unknown error."}</span>
          <div className="flex gap-2">
            <Button onClick={query.reload} size="sm" variant="outline">
              Retry
            </Button>
            <Button
              onClick={() => navigate({ name: "overview" })}
              size="sm"
              variant="ghost"
            >
              Back to overview
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    );
  }

  const detail = query.data;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="font-heading font-semibold text-xl tracking-tight">
              {detail.project.name}
            </h1>
            <StatusPill state={detail.state} />
          </div>
          <p className="mt-1 text-muted-foreground text-sm">
            {detail.project.slug} · checked {formatRelative(detail.checkedAt)}
            {totalDriftCounts(detail.counts) > 0
              ? ` · ${totalDriftCounts(detail.counts)} drift items`
              : ""}
          </p>
        </div>
        <Tabs
          onValueChange={(value) => setMode(value as ViewMode)}
          value={mode}
        >
          <TabsList size="sm">
            <TabsTab value="designer">Designer</TabsTab>
            <TabsTab value="developer">Developer</TabsTab>
          </TabsList>
        </Tabs>
      </div>

      <Tabs
        onValueChange={(value) =>
          navigate({
            name: "project",
            projectId,
            view: value as ProjectView,
          })
        }
        value={view}
      >
        <TabsList>
          <TabsTab value="overview">Project</TabsTab>
          <TabsTab value="deprecations">Deprecations</TabsTab>
          <TabsTab value="connections">Connections</TabsTab>
        </TabsList>
      </Tabs>

      {view === "overview" ? (
        <ProjectOverview detail={detail} mode={mode} />
      ) : null}
      {view === "deprecations" ? (
        <DeprecationsScreen
          detail={detail}
          onDetailChange={query.reload}
          projectId={projectId}
        />
      ) : null}
      {view === "connections" ? (
        <ConnectionsScreen projectId={projectId} />
      ) : null}
    </div>
  );
}
