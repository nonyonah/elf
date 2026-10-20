import { Check, Copy, KeyRound, Plus, Users } from "@/components/icons";
import * as React from "react";
import { Panel } from "@/components/panel";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { formatDateTime, formatRelative } from "@/lib/format";
import type {
  IssuedToken,
  OverviewResponse,
  TokenKind,
  TokenSummary,
  WorkspaceResponse,
} from "@/lib/types";
import { useQuery } from "@/lib/use-query";

function TokenResultDialog({
  issued,
  onDone,
}: {
  issued: IssuedToken | null;
  onDone: () => void;
}): React.ReactElement {
  const [copied, setCopied] = React.useState(false);
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          setCopied(false);
          onDone();
        }
      }}
      open={issued !== null}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {issued?.tokenInfo.kind === "plugin" ? "Plugin token" : "Push token"} ready
          </DialogTitle>
          <DialogDescription>
            Copy it now — the API only stores a hash, so it can never be shown again.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <code className="block break-all rounded-lg bg-muted p-3 font-mono text-xs">
            {issued?.token}
          </code>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>
            Done
          </DialogClose>
          <Button
            onClick={() => {
              if (!issued) return;
              void navigator.clipboard.writeText(issued.token).then(() => {
                setCopied(true);
                toastManager.add({ title: "Token copied", type: "success" });
              });
            }}
            type="button"
          >
            {copied ? <Check /> : <Copy />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function IssueTokenDialog({
  projectId,
  open,
  onOpenChange,
  onIssued,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIssued: (issued: IssuedToken) => void;
}): React.ReactElement {
  const api = useApi();
  const [kind, setKind] = React.useState<TokenKind>("push");
  const [label, setLabel] = React.useState("");
  const [pending, setPending] = React.useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    try {
      const issued = await api.post<IssuedToken>(`/projects/${projectId}/tokens`, {
        kind,
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      onOpenChange(false);
      setLabel("");
      onIssued(issued);
    } catch (cause) {
      toastManager.add({
        description: cause instanceof Error ? cause.message : "Something went wrong.",
        title: "Could not issue the token",
        type: "error",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup>
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Issue a token</DialogTitle>
            <DialogDescription>
              Push tokens feed `elf push`; plugin tokens feed the Figma bridge.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-5">
            <Field>
              <FieldLabel>Kind</FieldLabel>
              <Select onValueChange={(value) => setKind(value as TokenKind)} value={kind}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="push">Push — elf push / elf-watch</SelectItem>
                  <SelectItem value="plugin">Plugin — Elf Bridge (Figma)</SelectItem>
                </SelectPopup>
              </Select>
            </Field>
            <Field>
              <FieldLabel>Label</FieldLabel>
              <Input
                onChange={(event) => setLabel(event.target.value)}
                placeholder="e.g. CI on main, Sofia's laptop"
                value={label}
              />
              <FieldDescription>Optional — helps you tell tokens apart.</FieldDescription>
            </Field>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancel
            </DialogClose>
            <Button disabled={pending} type="submit">
              {pending ? "Issuing…" : "Issue token"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function RevokeTokenButton({
  projectId,
  token,
  onRevoked,
}: {
  projectId: string;
  token: TokenSummary;
  onRevoked: () => void;
}): React.ReactElement {
  const api = useApi();
  const [pending, setPending] = React.useState(false);

  async function revoke(): Promise<void> {
    if (pending) return;
    setPending(true);
    try {
      await api.post(`/projects/${projectId}/tokens/${token.id}/revoke`);
      toastManager.add({
        description: `The token ending …${token.last4} stops working immediately.`,
        title: "Token revoked",
        type: "success",
      });
      onRevoked();
    } catch (cause) {
      toastManager.add({
        description: cause instanceof Error ? cause.message : "Something went wrong.",
        title: "Could not revoke the token",
        type: "error",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button type="button" size="sm" variant="ghost">
            Revoke
          </Button>
        }
      />
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke this token?</AlertDialogTitle>
          <AlertDialogDescription>
            Anything using …{token.last4} will get 401s on its next request. The audit
            trail keeps the row.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button type="button" variant="outline" />}>
            Cancel
          </AlertDialogClose>
          <Button disabled={pending} onClick={() => void revoke()} variant="destructive">
            {pending ? "Revoking…" : "Revoke"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function ProjectTokensPanel({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}): React.ReactElement {
  const api = useApi();
  const query = useQuery<{ tokens: TokenSummary[] }>(
    () => api.get(`/projects/${projectId}/tokens`),
    [projectId],
  );
  const [issueOpen, setIssueOpen] = React.useState(false);
  const [issued, setIssued] = React.useState<IssuedToken | null>(null);

  return (
    <Panel
      action={
        <Button onClick={() => setIssueOpen(true)} size="sm" variant="outline">
          <Plus />
          Issue token
        </Button>
      }
      description="Shown once at issue time; the API keeps only a hash and the last four characters."
      flush
      title={projectName}
    >
      {query.loading && !query.data ? (
        <div className="flex items-center gap-2 px-4 py-6 text-muted-foreground text-sm">
          <Spinner className="size-4" />
          Loading tokens…
        </div>
      ) : query.error || !query.data ? (
        <div className="flex items-center gap-3 px-4 py-6 text-sm">
          <span className="text-muted-foreground">{query.error}</span>
          <Button onClick={query.reload} size="sm" variant="outline">
            Retry
          </Button>
        </div>
      ) : query.data.tokens.length === 0 ? (
        <p className="px-4 py-6 text-muted-foreground text-sm">
          No tokens yet. Issue one for the CLI or the Figma bridge.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Token</TableHead>
              <TableHead>Tail</TableHead>
              <TableHead>Issued</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.data.tokens.map((token) => (
              <TableRow key={token.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Badge size="sm" variant={token.kind === "push" ? "info" : "outline"}>
                      {token.kind === "push" ? "Push" : "Plugin"}
                    </Badge>
                    <span className="text-sm">{token.label ?? "No label"}</span>
                  </div>
                </TableCell>
                <TableCell className="font-mono text-muted-foreground text-xs">
                  …{token.last4}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  {formatDateTime(token.createdAt)}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  {token.lastUsedAt ? formatRelative(token.lastUsedAt) : "never"}
                </TableCell>
                <TableCell>
                  {token.revokedAt ? (
                    <Badge size="sm" variant="secondary">
                      Revoked
                    </Badge>
                  ) : (
                    <Badge size="sm" variant="success">
                      Active
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {token.revokedAt ? null : (
                    <RevokeTokenButton
                      onRevoked={query.reload}
                      projectId={projectId}
                      token={token}
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <IssueTokenDialog
        onIssued={setIssued}
        onOpenChange={setIssueOpen}
        open={issueOpen}
        projectId={projectId}
      />
      <TokenResultDialog issued={issued} onDone={() => setIssued(null)} />
    </Panel>
  );
}

export function SettingsScreen({
  overview,
}: {
  overview: OverviewResponse;
}): React.ReactElement {
  const api = useApi();
  const query = useQuery<WorkspaceResponse>(() => api.get("/workspace"), []);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading font-semibold text-lg">Settings</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          Workspace, members and the tokens the CLI and the bridge use.
        </p>
      </div>

      <Panel
        action={<Badge variant="secondary">{overview.projects.length} project{overview.projects.length === 1 ? "" : "s"}</Badge>}
        description="One workspace per user in this version — created on first sign-in."
        title="Workspace"
      >
        <div className="flex flex-col gap-4">
          <div className="grid gap-1 text-sm">
            <span className="font-medium">{query.data?.workspace.name ?? overview.workspace.name}</span>
            <span className="font-mono text-muted-foreground text-xs">{overview.workspace.id}</span>
          </div>
          <div className="flex flex-col gap-2">
            <span className="flex items-center gap-2 text-muted-foreground text-xs uppercase tracking-wide">
              <Users className="size-3.5" />
              Members
            </span>
            {query.loading && !query.data ? (
              <Spinner className="size-4" />
            ) : (
              <ul className="flex flex-col gap-2">
                {(query.data?.members ?? []).map((member) => (
                  <li className="flex items-center gap-2 text-sm" key={member.userId}>
                    <span className="truncate font-mono text-xs">{member.userId}</span>
                    <Badge size="sm" variant="secondary">
                      {member.role}
                    </Badge>
                    <span className="text-muted-foreground text-xs">
                      joined {formatRelative(member.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Panel>

      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-muted-foreground" />
        <h2 className="font-heading font-medium text-sm">Access tokens</h2>
      </div>

      {overview.projects.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Create a project first — tokens are scoped to one project.
        </p>
      ) : (
        overview.projects.map((project) => (
          <ProjectTokensPanel
            key={project.id}
            projectId={project.id}
            projectName={project.name}
          />
        ))
      )}
    </div>
  );
}
