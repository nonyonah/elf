import * as React from "react";
import { Search } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface CommandItem {
  id: string;
  label: string;
  group: string;
  hint?: string;
  onSelect: () => void;
}

export function CommandMenu({
  items,
}: {
  items: CommandItem[];
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (item) =>
        item.label.toLowerCase().includes(needle) ||
        (item.hint ?? "").toLowerCase().includes(needle) ||
        item.group.toLowerCase().includes(needle),
    );
  }, [items, query]);

  React.useEffect(() => {
    setActive(0);
  }, [query, open]);

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  React.useEffect(() => {
    const activeItem = listRef.current?.querySelector<HTMLElement>(
      '[data-active="true"]',
    );
    activeItem?.scrollIntoView({ block: "nearest" });
  }, [active, filtered]);

  function run(item: CommandItem | undefined): void {
    if (!item) return;
    setOpen(false);
    setQuery("");
    item.onSelect();
  }

  let lastGroup = "";

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      open={open}
    >
      <Button
        aria-label="Search projects"
        className="h-8 w-auto gap-2 border border-input bg-muted/60 px-2.5 text-[13px] text-muted-foreground hover:text-foreground sm:w-72"
        onClick={() => setOpen(true)}
        size="sm"
        variant="ghost"
      >
        <Search className="size-3.5" />
        <span className="hidden sm:inline">Search projects…</span>
        <kbd className="ms-auto hidden rounded border border-border px-1 font-mono text-[12px] sm:inline">
          ⌘K
        </kbd>
      </Button>
      <DialogPopup className="gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Command menu</DialogTitle>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <Input
            autoFocus
            className="border-0 bg-transparent shadow-none focus-visible:ring-0"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((index) => Math.min(index + 1, filtered.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((index) => Math.max(index - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                run(filtered[active]);
              }
            }}
            placeholder="Search projects and pages…"
            unstyled
            value={query}
          />
        </div>
        {filtered.length === 0 ? (
          <Empty className="px-6 py-10">
            <EmptyHeader>
              <EmptyTitle>No matches</EmptyTitle>
              <EmptyDescription>
                Nothing here for “{query.trim()}”.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div
            className="max-h-72 overflow-y-auto p-1"
            ref={listRef}
            role="listbox"
          >
            {filtered.map((item, index) => {
              const showGroup = item.group !== lastGroup;
              lastGroup = item.group;
              return (
                <React.Fragment key={item.id}>
                  {showGroup ? (
                    <div className="px-3 pt-2 pb-1 text-[13px] text-muted-foreground">
                      {item.group}
                    </div>
                  ) : null}
                  <button
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] outline-none",
                      index === active && "bg-accent text-accent-foreground",
                    )}
                    data-active={index === active}
                    onClick={() => run(item)}
                    onMouseEnter={() => setActive(index)}
                    role="option"
                    aria-selected={index === active}
                    type="button"
                  >
                    <span className="truncate">{item.label}</span>
                    {item.hint ? (
                      <span className="ms-auto truncate text-[13px] text-muted-foreground">
                        {item.hint}
                      </span>
                    ) : null}
                  </button>
                </React.Fragment>
              );
            })}
          </div>
        )}
      </DialogPopup>
    </Dialog>
  );
}
