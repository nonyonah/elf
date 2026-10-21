import { Box, ChevronDownIcon, Sparkles, XIcon } from "@/components/icons";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@/components/ui/popover";
import { toastManager } from "@/components/ui/toast";
import { useApi } from "@/lib/api-context";
import { errorMessage } from "@/lib/format";
import { cn } from "@/lib/utils";

const PROJECT_EMOJIS = [
  "🎨",
  "🧩",
  "🚀",
  "🌊",
  "🔥",
  "🌱",
  "🧠",
  "🛠️",
  "📦",
  "🪄",
  "🎯",
  "🧪",
  "🧭",
  "🪐",
  "🌈",
  "🍀",
  "🦄",
  "🐙",
  "🧊",
  "⚡",
  "💎",
  "🗂️",
  "🧵",
  "🧱",
];

export function ProjectIcon({
  icon,
  className,
}: {
  icon: string | null;
  className?: string;
}): React.ReactElement {
  if (icon) {
    return (
      <span
        aria-hidden
        className={cn(
          "inline-flex size-4 shrink-0 items-center justify-center text-[15px] leading-none",
          className,
        )}
      >
        {icon}
      </span>
    );
  }
  return (
    <Box
      className={cn("size-4 shrink-0 text-muted-foreground", className)}
    />
  );
}

export function EmojiPicker({
  value,
  onChange,
  className,
  align = "start",
}: {
  value: string | null;
  onChange: (icon: string | null) => void;
  className?: string;
  align?: "start" | "center" | "end";
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);

  function choose(icon: string | null): void {
    onChange(icon);
    setOpen(false);
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <Button
            className={cn("justify-start gap-2 font-normal", className)}
            type="button"
            variant="outline"
          />
        }
      >
        <ProjectIcon icon={value} />
        <span className={value ? "text-foreground" : "text-muted-foreground"}>
          {value ? "Change icon" : "Pick an icon"}
        </span>
        <ChevronDownIcon className="ms-auto size-3.5 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverPopup align={align} className="w-72">
        <EmojiPickerBody onChange={choose} value={value} />
      </PopoverPopup>
    </Popover>
  );
}

export function ProjectIconEditor({
  projectId,
  icon,
  onSaved,
  compact = false,
}: {
  projectId: string;
  icon: string | null;
  onSaved: () => void;
  compact?: boolean;
}): React.ReactElement {
  const api = useApi();
  const [value, setValue] = React.useState<string | null>(icon);
  const [saving, setSaving] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    setValue(icon);
  }, [icon]);

  async function save(next: string | null): Promise<void> {
    if (saving) return;
    const previous = value;
    setValue(next);
    setSaving(true);
    try {
      await api.patch(`/projects/${projectId}`, { icon: next });
      onSaved();
    } catch (cause) {
      setValue(previous);
      toastManager.add({
        description: errorMessage(cause),
        title: "Could not update the project icon",
        type: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  if (compact) {
    return (
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger
          render={
            <Button
              aria-label="Change project icon"
              className="size-8 text-base"
              size="icon"
              type="button"
              variant="ghost"
            />
          }
        >
          <ProjectIcon icon={value} className="size-4.5" />
        </PopoverTrigger>
        <PopoverPopup align="start" className="w-72">
          <EmojiPickerBody
            onChange={(next) => {
              setOpen(false);
              void save(next);
            }}
            value={value}
          />
        </PopoverPopup>
      </Popover>
    );
  }

  return (
    <EmojiPicker onChange={(next) => void save(next)} value={value} />
  );
}

function EmojiPickerBody({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (icon: string | null) => void;
}): React.ReactElement {
  const [custom, setCustom] = React.useState("");
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-muted-foreground text-[13px]">
          <Sparkles className="size-3.5" />
          Project icon
        </span>
        {value ? (
          <Button
            onClick={() => onChange(null)}
            size="sm"
            type="button"
            variant="ghost"
          >
            <XIcon />
            Remove
          </Button>
        ) : null}
      </div>
      <div className="grid grid-cols-8 gap-0.5">
        {PROJECT_EMOJIS.map((emoji) => (
          <Button
            aria-label={`Use ${emoji}`}
            aria-pressed={value === emoji}
            className={cn("text-base", value === emoji && "bg-accent")}
            key={emoji}
            onClick={() => onChange(emoji)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            {emoji}
          </Button>
        ))}
      </div>
      <form
        className="flex items-center gap-2 border-t pt-3"
        onSubmit={(event) => {
          event.preventDefault();
          const icon = custom.trim();
          if (!icon) return;
          onChange(icon);
          setCustom("");
        }}
      >
        <Input
          className="h-8"
          maxLength={24}
          onChange={(event) => setCustom(event.target.value)}
          placeholder="Or paste an emoji…"
          value={custom}
        />
        <Button disabled={!custom.trim()} size="sm" type="submit">
          Use
        </Button>
      </form>
    </div>
  );
}
