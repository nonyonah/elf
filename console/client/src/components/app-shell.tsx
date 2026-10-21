import { useClerk, useUser } from "@clerk/react";
import {
  BookOpen,
  Boxes,
  ChevronDownIcon,
  ChevronRight,
  ChevronRightIcon,
  History,
  LayoutDashboard,
  LogOut,
  Settings,
} from "@/components/icons";
import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { CommandMenu } from "@/components/command-menu";
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
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
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
} from "@/components/ui/sidebar";
import { useApi } from "@/lib/api-context";
import { errorMessage, totalDriftCounts } from "@/lib/format";
import type { Route } from "@/lib/router";
import { hrefFor, navigate } from "@/lib/router";
import type { OverviewResponse } from "@/lib/types";

function BrandMark(): React.ReactElement {
  return (
    <div className="flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-foreground font-heading font-semibold text-[12px] text-background">
      e
    </div>
  );
}

function WorkspaceSwitcher({
  workspace,
}: {
  workspace: OverviewResponse["workspace"];
}): React.ReactElement {
  const initial = workspace.name.trim()[0]?.toUpperCase() ?? "W";

  return (
    <Menu>
      <MenuTrigger className="mt-1 flex h-7 w-full min-w-0 items-center gap-1.5 rounded-lg px-1.5 text-left outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring">
        <span className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-card font-medium text-[10px] text-foreground">
          {initial}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium text-[13px] text-foreground">
          {workspace.name}
        </span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
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
        className="flex h-7 items-center gap-1 rounded-full p-0.5 pe-1.5 text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Avatar className="size-6 rounded-full">
          <AvatarImage alt={name} src={user.imageUrl} />
          <AvatarFallback className="rounded-full text-[10px]">
            {initials || "?"}
          </AvatarFallback>
        </Avatar>
        <ChevronDownIcon className="size-3.5" />
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

function Breadcrumbs({
  overview,
  route,
}: {
  overview: OverviewResponse;
  route: Route;
}): React.ReactElement {
  if (route.name === "overview") {
    return <span className="font-medium text-[13px]">Overview</span>;
  }
  if (route.name === "activity") {
    return <span className="font-medium text-[13px]">Activity</span>;
  }
  if (route.name === "settings") {
    return <span className="font-medium text-[13px]">Settings</span>;
  }
  const project =
    overview.projects.find((entry) => entry.id === route.projectId) ?? null;
  const viewLabel = route.view === "deprecations" ? "Deprecations" : null;
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <a
        className="text-muted-foreground text-[13px] hover:text-foreground"
        href="#/"
      >
        Projects
      </a>
      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />
      <a
        className={
          viewLabel
            ? "truncate text-muted-foreground text-[13px] hover:text-foreground"
            : "truncate font-medium text-[13px]"
        }
        href={hrefFor({ name: "project", projectId: route.projectId, view: "overview" })}
      >
        {project?.name ?? "Project"}
      </a>
      {viewLabel ? (
        <>
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />
          <span className="truncate font-medium text-[13px]">{viewLabel}</span>
        </>
      ) : null}
    </div>
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
        <Spinner className="size-4" />
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
    <SidebarProvider className="h-svh overflow-hidden bg-page">
      <div className="flex h-full min-h-0 w-full gap-2 overflow-hidden">
        <Sidebar
          className="static! h-full! min-w-0 overflow-hidden border-r-0! [&_[data-slot=sidebar-gap]]:hidden group-data-[side=left]:border-r-0! group-data-[state=collapsed]:w-0"
          collapsible="offcanvas"
        >
          <SidebarHeader className="gap-0 px-3 pt-2 pb-1">
            <a
              aria-label="elf console"
              className="flex h-11 w-fit items-center"
              href="#/"
            >
              <BrandMark />
            </a>
            <WorkspaceSwitcher workspace={overview.workspace} />
          </SidebarHeader>
        <SidebarContent className="pt-3">
          <SidebarGroup className="p-0 px-3">
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={route.name === "overview"}
                    render={<a href="#/" />}
                    tooltip="Overview"
                  >
                    <LayoutDashboard />
                    <span>Overview</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {overview.projects.length === 0 ? (
                  <SidebarMenuItem>
                    <span className="px-2 py-1 text-muted-foreground text-[13px]">
                      No projects yet
                    </span>
                  </SidebarMenuItem>
                ) : (
                  <Collapsible className="group/projects" defaultOpen>
                    <SidebarMenuItem>
                      <CollapsibleTrigger
                        render={<SidebarMenuButton />}
                      >
                        <Boxes />
                        <span>Projects</span>
                        <ChevronRightIcon className="ms-auto size-3.5 text-muted-foreground transition-transform group-data-[open]/projects:rotate-90" />
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <SidebarMenuSub>
                          {overview.projects.map((project) => {
                            const driftCount = totalDriftCounts(project.counts);
                            const isActive =
                              route.name === "project" &&
                              route.projectId === project.id;
                            return (
                              <SidebarMenuSubItem key={project.id}>
                                <SidebarMenuSubButton
                                  className="pe-7"
                                  isActive={isActive}
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
                                  <ProjectIcon icon={project.icon} className="size-3.5" />
                                  <span className="truncate">
                                    {project.name}
                                  </span>
                                  {driftCount > 0 ? (
                                    <span className="ms-auto shrink-0 text-warning-foreground text-[11px] tabular-nums">
                                      {driftCount}
                                    </span>
                                  ) : null}
                                </SidebarMenuSubButton>
                              </SidebarMenuSubItem>
                            );
                          })}
                        </SidebarMenuSub>
                      </CollapsibleContent>
                    </SidebarMenuItem>
                  </Collapsible>
                )}
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={route.name === "activity"}
                    render={<a href={hrefFor({ name: "activity" })} />}
                    tooltip="Activity"
                  >
                    <History />
                    <span>Activity</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={route.name === "settings"}
                    render={<a href={hrefFor({ name: "settings" })} />}
                    tooltip="Settings"
                  >
                    <Settings />
                    <span>Settings</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="gap-1 px-3 py-2">
          <SlackConnectButton overview={overview} route={route} />
          <DocsLink />
        </SidebarFooter>
        </Sidebar>
        <SidebarInset className="min-h-0 min-w-0 flex-1 bg-transparent p-2 md:pl-0">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[12px] bg-card shadow-shell">
          <header className="relative z-20 flex h-12 shrink-0 items-center gap-2 border-b border-border-soft bg-card px-3">
            <SidebarTrigger />
            <Separator className="me-1 data-[orientation=vertical]:h-4" orientation="vertical" />
            <Breadcrumbs overview={overview} route={route} />
            <div className="ms-auto flex items-center gap-1">
              <div className="sm:absolute sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2">
                <CommandMenu items={commandItems} />
              </div>
              <AccountMenu devMode={devMode} />
            </div>
          </header>
          <div
            className="min-h-0 flex-1 overflow-y-auto bg-card px-4 py-6 sm:px-6 lg:px-8"
            ref={scrollRef}
          >
              <div className="mx-auto w-full max-w-6xl">{children}</div>
            </div>
          </div>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
