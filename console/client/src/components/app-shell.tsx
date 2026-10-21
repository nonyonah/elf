import { useClerk, useUser } from "@clerk/react";
import {
  BookOpen,
  Box,
  CaretDown,
  ClockCounterClockwise,
  GearSix,
  House,
  LogOut,
  Plus,
  Settings,
  SlidersHorizontal,
  SquaresFour,
  TriangleAlert,
} from "@/components/icons";
import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { CommandMenu } from "@/components/command-menu";
import { useCreateProject } from "@/components/create-project";
import { ProjectIcon } from "@/components/project-icon";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { useApi } from "@/lib/api-context";
import { errorMessage, totalDriftCounts } from "@/lib/format";
import type { Route } from "@/lib/router";
import { hrefFor, navigate } from "@/lib/router";
import type { OverviewResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

function WorkspaceSwitcher({
  workspace,
}: {
  workspace: OverviewResponse["workspace"];
}): React.ReactElement {
  const initial = workspace.name.trim()[0]?.toUpperCase() ?? "W";

  return (
    <Menu>
      <MenuTrigger className="flex h-9 min-w-0 items-center gap-2 rounded-lg px-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary font-semibold text-[11px] text-primary-foreground">
          {initial}
        </span>
        <span className="min-w-0 truncate font-medium text-[13px] text-foreground">
          {workspace.name}
        </span>
        <CaretDown className="size-3 shrink-0 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-52" side="bottom">
        <div className="px-2 py-1.5">
          <p className="text-muted-foreground text-[11px]">Workspace</p>
          <p className="truncate font-medium text-[13px] text-foreground">
            {workspace.name}
          </p>
        </div>
        <MenuSeparator />
        <MenuItem onClick={() => navigate({ name: "settings" })}>
          <Settings />
          Workspace settings
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function TopbarSidebarTrigger(): React.ReactElement {
  const { state } = useSidebar();

  return (
    <SidebarTrigger
      className={cn(state === "expanded" && "md:hidden")}
      aria-label="Open sidebar"
    />
  );
}

function AccountMenu({ devMode }: { devMode: boolean }): React.ReactElement {
  const { user } = useUser();
  const { signOut } = useClerk();

  if (devMode) {
    return (
      <span
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-[11px] text-muted-foreground"
        title="Dev preview · Clerk bypass"
      >
        DV
      </span>
    );
  }
  if (!user) return <div className="size-7" />;

  const name = user.fullName ?? user.username ?? "Signed in";
  const email = user.primaryEmailAddress?.emailAddress ?? "";
  const initials = (user.fullName ?? email)
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <Menu>
      <MenuTrigger
        aria-label="Account"
        className="flex h-8 items-center gap-1 rounded-full p-0.5 pe-1.5 text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Avatar className="size-6 rounded-full">
          <AvatarImage alt={name} src={user.imageUrl} />
          <AvatarFallback className="rounded-full text-[10px]">
            {initials || "?"}
          </AvatarFallback>
        </Avatar>
        <CaretDown className="size-3" />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-60" side="bottom">
        <div className="px-2 py-1.5">
          <p className="truncate font-medium text-[13px] text-foreground">{name}</p>
          <p className="truncate text-muted-foreground text-[12px]">{email}</p>
        </div>
        <MenuSeparator />
        <MenuItem onClick={() => void signOut()}>
          <LogOut />
          Sign out
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function AppRail({
  overview,
  route,
}: {
  overview: OverviewResponse;
  route: Route;
}): React.ReactElement {
  const firstProject = overview.projects[0];
  const projectHref = firstProject
    ? hrefFor({
        name: "project",
        projectId: firstProject.id,
        view: "overview",
      })
    : "#/";

  const items = [
    {
      active: route.name === "overview",
      href: "#/",
      icon: SquaresFour,
      label: "Overview",
    },
    {
      active: route.name === "project",
      href: projectHref,
      icon: Box,
      label: "Projects",
    },
    {
      active: route.name === "activity",
      href: hrefFor({ name: "activity" }),
      icon: ClockCounterClockwise,
      label: "Activity",
    },
  ];

  return (
    <nav
      aria-label="Primary"
      className="hidden w-[60px] shrink-0 flex-col items-center gap-1 bg-sidebar px-1.5 py-3 md:flex"
    >
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <a
            aria-current={item.active ? "page" : undefined}
            className={cn(
              "flex h-[52px] w-full flex-col items-center justify-center gap-1 rounded-lg text-[10px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring",
              item.active
                ? "text-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
            )}
            href={item.href}
            key={item.label}
          >
            <span
              className={cn(
                "flex size-8 items-center justify-center rounded-lg transition-colors",
                item.active && "bg-foreground text-background",
              )}
            >
              <Icon className="size-[18px]" />
            </span>
            {item.label}
          </a>
        );
      })}
      <div className="mt-auto flex w-full flex-col items-center gap-1 pt-2">
        <div className="mb-1 h-px w-8 bg-sidebar-border" />
        <a
          aria-current={route.name === "settings" ? "page" : undefined}
          className={cn(
            "flex h-[52px] w-full flex-col items-center justify-center gap-1 rounded-lg text-[10px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring",
            route.name === "settings"
              ? "text-foreground"
              : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
          )}
          href={hrefFor({ name: "settings" })}
        >
          <span
            className={cn(
              "flex size-8 items-center justify-center rounded-lg transition-colors",
              route.name === "settings" && "bg-foreground text-background",
            )}
          >
            <GearSix className="size-[18px]" />
          </span>
          Settings
        </a>
      </div>
    </nav>
  );
}

function SlackConnectButton({
  overview,
  route,
}: {
  overview: OverviewResponse;
  route: Route;
}): React.ReactElement {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const project =
    (route.name === "project"
      ? overview.projects.find((entry) => entry.id === route.projectId)
      : undefined) ?? overview.projects[0];
  const disabled = busy || !project || !overview.slackConfigured;

  async function connect(): Promise<void> {
    if (busy || !project) return;
    setBusy(true);
    try {
      const result = await api.get<{ url: string }>(
        `/projects/${project.id}/connections/slack/install`,
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

  return (
    <Button
      className="h-7 w-full justify-start gap-1.5 rounded-lg px-2 font-medium text-[13px] text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
      disabled={disabled}
      onClick={() => void connect()}
      size="sm"
      title={
        !overview.slackConfigured
          ? "Slack is not configured on this server"
          : project
            ? `Connect ${project.name} to Slack`
            : "Create a project first"
      }
      variant="ghost"
    >
      {busy ? (
        <Spinner className="size-3.5" />
      ) : (
        <img
          alt=""
          className="size-3.5"
          height={14}
          src="https://upload.wikimedia.org/wikipedia/commons/d/d5/Slack_icon_2019.svg"
          width={14}
        />
      )}
      Connect to Slack
    </Button>
  );
}

function DocsLink(): React.ReactElement {
  return (
    <a
      className="flex h-7 items-center gap-1.5 rounded-lg px-2 font-medium text-[13px] text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      href="https://github.com/nonyonah/elf/blob/main/console/README.md"
      rel="noreferrer"
      target="_blank"
    >
      <BookOpen className="size-3.5" />
      Docs
    </a>
  );
}

function WorkspaceHealthCard({
  summary,
}: {
  summary: OverviewResponse["summary"];
}): React.ReactElement {
  const total = Math.max(summary.total, 1);
  const driftShare = Math.min((summary.drift / total) * 100, 100);
  const okShare = Math.min((summary.ok / total) * 100, 100);

  return (
    <div className="rounded-lg border border-sidebar-border bg-card p-3">
      <div className="flex items-center gap-1.5 font-medium text-[12px] text-foreground">
        <span
          className={cn(
            "size-1.5 rounded-full",
            summary.drift > 0 ? "bg-warning-foreground" : "bg-success-foreground",
          )}
        />
        {summary.drift > 0 ? "Needs attention" : "All in sync"}
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {summary.drift} of {summary.total} projects in drift
      </p>
      <div className="mt-2 flex h-1 overflow-hidden rounded-full bg-muted">
        <span
          className="h-full bg-warning-foreground"
          style={{ width: `${driftShare}%` }}
        />
        <span
          className="h-full bg-success-foreground"
          style={{ width: `${okShare}%` }}
        />
      </div>
    </div>
  );
}

function ProjectTree({
  overview,
  route,
}: {
  overview: OverviewResponse;
  route: Route;
}): React.ReactElement {
  if (overview.projects.length === 0) {
    return (
      <p className="px-2 py-1.5 text-[13px] text-muted-foreground">
        No projects yet
      </p>
    );
  }

  return (
    <Collapsible className="group/projects" defaultOpen>
      <CollapsibleTrigger
        render={
          <button
            className="flex h-7 w-full items-center gap-1 rounded-lg px-2 font-medium text-[12px] text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground"
            type="button"
          />
        }
      >
        Projects
        <CaretDown className="size-3 rotate-180 transition-transform group-data-[open]/projects:rotate-0" />
        <span className="ms-auto text-[11px] tabular-nums">
          {overview.projects.length}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <SidebarMenu className="mt-1">
          {overview.projects.map((project) => {
            const driftCount = totalDriftCounts(project.counts);
            const isActive =
              route.name === "project" && route.projectId === project.id;
            return (
              <SidebarMenuItem key={project.id}>
                <SidebarMenuButton
                  render={
                    <a
                      href={hrefFor({
                        name: "project",
                        projectId: project.id,
                        view: "overview",
                      })}
                    />
                  }
                  tooltip={project.name}
                >
                  <ProjectIcon className="size-4" icon={project.icon} />
                  <span className="truncate">{project.name}</span>
                  {driftCount > 0 ? (
                    <span className="ms-auto shrink-0 text-warning-foreground text-[11px] tabular-nums">
                      {driftCount}
                    </span>
                  ) : null}
                </SidebarMenuButton>
                {isActive ? (
                  <SidebarMenuSub>
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton
                        isActive={route.view === "overview"}
                        render={
                          <a
                            href={hrefFor({
                              name: "project",
                              projectId: project.id,
                              view: "overview",
                            })}
                          />
                        }
                      >
                        <House />
                        <span>Overview</span>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton
                        isActive={route.view === "deprecations"}
                        render={
                          <a
                            href={hrefFor({
                              name: "project",
                              projectId: project.id,
                              view: "deprecations",
                            })}
                          />
                        }
                      >
                        <TriangleAlert />
                        <span>Deprecations</span>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  </SidebarMenuSub>
                ) : null}
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function AppShell({
  overview,
  route,
  devMode = false,
  children,
}: {
  overview: OverviewResponse;
  route: Route;
  devMode?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const { openCreateProject } = useCreateProject();
  const scrollRef = useRef<HTMLDivElement>(null);
  const routeKey = hrefFor(route);
  const commandItems = [
    ...overview.projects.map((project) => ({
      group: "Projects",
      hint: project.slug,
      id: project.id,
      label: project.name,
      onSelect: () =>
        navigate({
          name: "project",
          projectId: project.id,
          view: "overview",
        }),
    })),
    {
      group: "Workspace",
      id: "overview",
      label: "Overview",
      onSelect: () => navigate({ name: "overview" }),
    },
    {
      group: "Workspace",
      id: "activity",
      label: "Activity",
      onSelect: () => navigate({ name: "activity" }),
    },
    {
      group: "Workspace",
      id: "settings",
      label: "Settings",
      onSelect: () => navigate({ name: "settings" }),
    },
  ];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [routeKey]);

  return (
    <SidebarProvider className="h-svh flex-col overflow-hidden bg-card">
      <header className="relative z-30 flex h-[60px] shrink-0 items-center gap-3 border-border-soft border-b bg-card px-3">
        <div className="flex min-w-0 items-center gap-2 md:w-[310px]">
          <TopbarSidebarTrigger />
          <WorkspaceSwitcher workspace={overview.workspace} />
        </div>
        <div className="flex min-w-0 flex-1 justify-center px-2">
          <CommandMenu items={commandItems} />
        </div>
        <div className="flex shrink-0 items-center justify-end gap-1 lg:w-[310px]">
          <AccountMenu devMode={devMode} />
        </div>
      </header>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <AppRail overview={overview} route={route} />
        <Sidebar
          className="static! h-full! min-w-0 overflow-hidden border-sidebar-border transition-[width] duration-200 group-data-[side=left]:border-r group-data-[state=collapsed]:w-0! group-data-[state=collapsed]:border-r-0 [&_[data-slot=sidebar-gap]]:hidden"
          collapsible="offcanvas"
        >
          <SidebarHeader className="gap-0 px-3 pt-3 pb-2">
            <div className="flex h-8 items-center justify-between">
              <span className="font-heading font-semibold text-[15px] text-foreground">
                Workspace
              </span>
              <div className="flex items-center gap-0.5">
                <Button
                  aria-label="Workspace settings"
                  className="size-7 text-muted-foreground"
                  onClick={() => navigate({ name: "settings" })}
                  size="icon-sm"
                  variant="ghost"
                >
                  <SlidersHorizontal className="size-4" />
                </Button>
                <SidebarTrigger className="size-7 text-muted-foreground" />
              </div>
            </div>
            <Button
              className="mt-2 h-9 w-full justify-start gap-1.5 rounded-lg border-border-soft bg-card font-medium text-[13px] shadow-none sm:h-9"
              onClick={openCreateProject}
              variant="outline"
            >
              <Plus className="size-3.5" />
              New project
            </Button>
          </SidebarHeader>
          <SidebarContent className="gap-4 px-3 pt-2">
            <SidebarGroup className="p-0">
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      isActive={route.name === "overview"}
                      render={<a href="#/" />}
                      tooltip="Overview"
                    >
                      <House />
                      <span>Overview</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
                <ProjectTree overview={overview} route={route} />
                <SidebarMenu className="mt-4 md:hidden">
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      isActive={route.name === "activity"}
                      render={<a href={hrefFor({ name: "activity" })} />}
                    >
                      <ClockCounterClockwise />
                      <span>Activity</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      isActive={route.name === "settings"}
                      render={<a href={hrefFor({ name: "settings" })} />}
                    >
                      <GearSix />
                      <span>Settings</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <div className="mt-auto px-2">
              <p className="mb-1 flex h-7 items-center font-medium text-[12px] text-muted-foreground">
                Try
              </p>
              <div className="flex flex-col gap-0.5">
                <SlackConnectButton overview={overview} route={route} />
                <DocsLink />
              </div>
            </div>
          </SidebarContent>
          <SidebarFooter className="p-3 pt-2">
            <WorkspaceHealthCard summary={overview.summary} />
          </SidebarFooter>
        </Sidebar>
        <SidebarInset className="min-h-0 min-w-0 flex-1 overflow-hidden bg-card">
          <div
            className="min-h-0 flex-1 overflow-y-auto bg-card px-4 py-6 sm:px-6 lg:px-8"
            ref={scrollRef}
          >
            <div className="mx-auto w-full max-w-6xl">{children}</div>
          </div>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
