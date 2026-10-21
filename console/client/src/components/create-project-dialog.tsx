import * as React from "react";
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
import { EmojiPicker } from "@/components/project-icon";
import { Input } from "@/components/ui/input";
import { toastManager } from "@/components/ui/toast";
import { useApi } from "@/lib/api-context";

export function CreateProjectDialog({
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
  const [icon, setIcon] = React.useState<string | null>(null);
  const [figmaUrl, setFigmaUrl] = React.useState("");
  const [figmaToken, setFigmaToken] = React.useState("");
  const [pending, setPending] = React.useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    if (figmaToken.trim() && !figmaUrl.trim()) return;
    setPending(true);
    try {
      const result = await api.post<{ project: { id: string; name: string } }>(
        "/projects",
        {
          name: trimmed,
          ...(icon ? { icon } : {}),
          ...(figmaUrl.trim() ? { figmaUrl: figmaUrl.trim() } : {}),
          ...(figmaToken.trim() ? { figmaToken: figmaToken.trim() } : {}),
        },
      );
      toastManager.add({
        description: figmaUrl.trim()
          ? `${result.project.name} is linked to its Figma file.`
          : `${result.project.name} is ready for its first push.`,
        title: "Project created",
        type: "success",
      });
      setName("");
      setIcon(null);
      setFigmaUrl("");
      setFigmaToken("");
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
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
          <DialogPanel className="flex flex-col gap-5">
            <Field>
              <FieldLabel>Project name</FieldLabel>
              <Input
                autoFocus
                maxLength={60}
                onChange={(event) => setName(event.target.value)}
                placeholder="Marketing site"
                value={name}
              />
            </Field>
            <Field>
              <FieldLabel>Icon</FieldLabel>
              <EmojiPicker className="w-full" onChange={setIcon} value={icon} />
              <FieldDescription>
                Pick a preset or paste your own emoji. It shows next to the
                project in the sidebar.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Figma project</FieldLabel>
              <Input
                onChange={(event) => setFigmaUrl(event.target.value)}
                placeholder="https://www.figma.com/design/…"
                value={figmaUrl}
              />
              <FieldDescription>
                Paste the file URL — the file key and name come from it.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Figma access token</FieldLabel>
              <Input
                autoComplete="off"
                onChange={(event) => setFigmaToken(event.target.value)}
                placeholder="figd_…"
                type="password"
                value={figmaToken}
              />
              <FieldDescription>
                Write-only. Used to poll the file and keep its name current.
              </FieldDescription>
            </Field>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancel
            </DialogClose>
            <Button
              disabled={
                pending || !name.trim() || (!!figmaToken.trim() && !figmaUrl.trim())
              }
              type="submit"
            >
              {pending ? "Creating…" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
