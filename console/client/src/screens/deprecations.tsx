import { Download, MoreHorizontal, Pencil, Plus, Trash2 } from "@/components/icons";
import * as React from "react";
import {
  Card,
  CardContent,
  CardFrame,
  CardFrameHeader,
  CardFrameTitle,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
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
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toastManager } from "@/components/ui/toast";
import { useApi } from "@/lib/api-context";
import { formatIsoDate, formatRelative } from "@/lib/format";
import type {
  Deprecation,
  DriftItem,
  DriftResult,
  ProjectDetailResponse,
} from "@/lib/types";
import { useQuery } from "@/lib/use-query";

type DeprecationType = "token" | "component";

interface StatusMeta {
  label: string;
  variant: "error" | "warning" | "info" | "secondary" | "outline";
}

function deprecationStatus(
  deprecation: Deprecation,
  details: DriftResult | null,
): StatusMeta {
  if (!details) return { label: "No data", variant: "outline" };
  const matches = (items: DriftItem[]): boolean =>
    items.some(
      (item) =>
        item.name === deprecation.name && item.kind === deprecation.type,
    );
  if (matches(details.deprecationOverdue)) {
    return { label: "Overdue", variant: "error" };
  }
  if (matches(details.deprecatedStillInCode)) {
    return { label: "Still in code", variant: "warning" };
  }
  if (matches(details.safeToRemoveFromDeprecations)) {
    return { label: "Safe to remove", variant: "info" };
  }
  return { label: "Not in code", variant: "secondary" };
}

interface FormState {
  name: string;
  type: DeprecationType;
  reason: string;
  since: string;
  removeBy: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  type: "token",
  reason: "",
  since: "",
  removeBy: "",
};

function DeprecationDialog({
  projectId,
  deprecation,
  open,
  onOpenChange,
  onSaved,
}: {
  projectId: string;
  deprecation: Deprecation | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}): React.ReactElement {
  const api = useApi();
  const [form, setForm] = React.useState<FormState>(EMPTY_FORM);
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setForm(
      deprecation
        ? {
            name: deprecation.name,
            type: deprecation.type,
            reason: deprecation.reason ?? "",
            since: deprecation.since?.slice(0, 10) ?? "",
            removeBy: deprecation.removeBy?.slice(0, 10) ?? "",
          }
        : EMPTY_FORM,
    );
  }, [open, deprecation]);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const name = form.name.trim();
    if (!name || pending) return;
    setPending(true);
    const payload = {
      name,
      type: form.type,
      reason: form.reason.trim() ? form.reason.trim() : null,
      since: form.since ? form.since : null,
      removeBy: form.removeBy ? form.removeBy : null,
    };
    try {
      if (deprecation) {
        await api.put(`/projects/${projectId}/deprecations/${deprecation.id}`, payload);
        toastManager.add({
          description: `${name} was updated.`,
          title: "Deprecation saved",
          type: "success",
        });
      } else {
        await api.post(`/projects/${projectId}/deprecations`, payload);
        toastManager.add({
          description: `${name} is on the way out.`,
          title: "Deprecation added",
          type: "success",
        });
      }
      onOpenChange(false);
      onSaved();
    } catch (cause) {
      toastManager.add({
        description:
          cause instanceof Error ? cause.message : "Something went wrong.",
        title: "Could not save the deprecation",
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
          <DialogTitle>
            {deprecation ? "Edit deprecation" : "Add deprecation"}
          </DialogTitle>
          <DialogDescription>
            Deprecations ride the remote config — every elf push sees them.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <DialogPanel className="flex flex-col gap-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <Field>
                <FieldLabel>Name</FieldLabel>
                <Input
                  autoFocus
                  maxLength={80}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  placeholder="colors.brand.legacy"
                  value={form.name}
                />
              </Field>
              <Field>
                <FieldLabel>Type</FieldLabel>
                <Select
                  onValueChange={(value) =>
                    setForm((current) => ({
                      ...current,
                      type: value as DeprecationType,
                    }))
                  }
                  value={form.type}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="token">Token</SelectItem>
                    <SelectItem value="component">Component</SelectItem>
                  </SelectPopup>
                </Select>
              </Field>
            </div>
            <Field>
              <FieldLabel>Reason</FieldLabel>
              <Textarea
                maxLength={200}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    reason: event.target.value,
                  }))
                }
                placeholder="Replaced by colors.brand.primary"
                rows={3}
                value={form.reason}
              />
              <FieldDescription>Optional, up to 200 characters.</FieldDescription>
            </Field>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field>
                <FieldLabel>Since</FieldLabel>
                <Input
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      since: event.target.value,
                    }))
                  }
                  type="date"
                  value={form.since}
                />
              </Field>
              <Field>
                <FieldLabel>Remove by</FieldLabel>
                <Input
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      removeBy: event.target.value,
                    }))
                  }
                  type="date"
                  value={form.removeBy}
                />
                <FieldDescription>
                  Past this date the deprecation counts as drift.
                </FieldDescription>
              </Field>
            </div>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancel
            </DialogClose>
            <Button disabled={pending || !form.name.trim()} type="submit">
              {pending ? "Saving…" : deprecation ? "Save changes" : "Add deprecation"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export function DeprecationsScreen({
  projectId,
  detail,
  onDetailChange,
}: {
  projectId: string;
  detail: ProjectDetailResponse;
  onDetailChange: () => void;
}): React.ReactElement {
  const api = useApi();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Deprecation | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<Deprecation | null>(
    null,
  );
  const [deleting, setDeleting] = React.useState(false);

  const query = useQuery<{ deprecations: Deprecation[] }>(
    () => api.get(`/projects/${projectId}/deprecations`),
    [projectId],
  );

  const deprecations = query.data?.deprecations ?? [];

  function reloadAll(): void {
    query.reload();
    onDetailChange();
  }

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await api.del(
        `/projects/${projectId}/deprecations/${deleteTarget.id}`,
      );
      toastManager.add({
        description: `${deleteTarget.name} is off the list.`,
        title: "Deprecation removed",
        type: "success",
      });
      setDeleteTarget(null);
      reloadAll();
    } catch (cause) {
      toastManager.add({
        description:
          cause instanceof Error ? cause.message : "Something went wrong.",
        title: "Could not remove the deprecation",
        type: "error",
      });
    } finally {
      setDeleting(false);
    }
  }

  function exportConfig(): void {
    const payload = {
      deprecations: deprecations.map((deprecation) => ({
        name: deprecation.name,
        type: deprecation.type,
        ...(deprecation.reason ? { reason: deprecation.reason } : {}),
        ...(deprecation.since ? { since: deprecation.since.slice(0, 10) } : {}),
        ...(deprecation.removeBy
          ? { removeBy: deprecation.removeBy.slice(0, 10) }
          : {}),
      })),
    };
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "elf.config.json";
    anchor.click();
    URL.revokeObjectURL(url);
    toastManager.add({
      description: "Merge it into the deprecations list in elf.config.json.",
      title: "Exported elf.config.json",
      type: "success",
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-muted-foreground text-sm">
          Tokens and components on their way out. The list here is the remote
          config every elf push reads.
        </p>
        <div className="flex items-center gap-2">
          <Button
            disabled={deprecations.length === 0}
            onClick={exportConfig}
            variant="outline"
          >
            <Download />
            Export elf.config.json
          </Button>
          <Button
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus />
            Add deprecation
          </Button>
        </div>
      </div>

      {query.loading && !query.data ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Spinner className="size-4" />
          Loading deprecations…
        </div>
      ) : query.error ? (
        <Card>
          <CardHeader>
            <CardTitle>Could not load deprecations</CardTitle>
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
      ) : deprecations.length === 0 ? (
        <Card>
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No deprecations yet</EmptyTitle>
              <EmptyDescription>
                Add a token or component to start the removal clock — elf push
                will flag it everywhere it is still used.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                onClick={() => {
                  setEditing(null);
                  setDialogOpen(true);
                }}
                variant="outline"
              >
                <Plus />
                Add deprecation
              </Button>
            </EmptyContent>
          </Empty>
        </Card>
      ) : (
        <CardFrame>
          <CardFrameHeader>
            <CardFrameTitle>{deprecations.length} deprecations</CardFrameTitle>
          </CardFrameHeader>
          <Table variant="card">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Since</TableHead>
                <TableHead>Remove by</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {deprecations.map((deprecation) => {
                const status = deprecationStatus(deprecation, detail.details);
                return (
                  <TableRow key={deprecation.id}>
                    <TableCell>
                      <span className="font-medium">{deprecation.name}</span>
                    </TableCell>
                    <TableCell>
                      <Badge size="sm" variant="secondary">
                        {deprecation.type}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge size="sm" variant={status.variant}>
                        {status.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-56 truncate text-muted-foreground">
                      {deprecation.reason ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatIsoDate(deprecation.since)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatIsoDate(deprecation.removeBy)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Menu>
                        <MenuTrigger
                          render={
                            <Button
                              aria-label={`Actions for ${deprecation.name}`}
                              size="icon-sm"
                              variant="ghost"
                            />
                          }
                        >
                          <MoreHorizontal />
                        </MenuTrigger>
                        <MenuPopup align="end">
                          <MenuItem
                            onClick={() => {
                              setEditing(deprecation);
                              setDialogOpen(true);
                            }}
                          >
                            <Pencil />
                            Edit
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem
                            onClick={() => setDeleteTarget(deprecation)}
                            variant="destructive"
                          >
                            <Trash2 />
                            Delete
                          </MenuItem>
                        </MenuPopup>
                      </Menu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardFrame>
      )}

      <p className="text-muted-foreground text-[13px]">
        Last checked {formatRelative(detail.checkedAt)}. Overdue deprecations
        count as drift.
      </p>

      <DeprecationDialog
        deprecation={editing}
        onOpenChange={setDialogOpen}
        onSaved={reloadAll}
        open={dialogOpen}
        projectId={projectId}
      />

      <AlertDialog
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        open={deleteTarget !== null}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this deprecation?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? `${deleteTarget.name} will no longer be flagged by elf push. You can add it back at any time.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              render={<Button type="button" variant="outline" />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              disabled={deleting}
              onClick={() => void confirmDelete()}
              variant="destructive"
            >
              {deleting ? "Removing…" : "Remove"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
