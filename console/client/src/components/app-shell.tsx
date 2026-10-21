import { useClerk, useUser } from "@clerk/react";
import {
  Box,
  Boxes,
  ChevronDownIcon,
  ChevronRight,
  ChevronsUpDown,
  History,
  LayoutDashboard,
  LogOut,
  Settings,
} from "@/components/icons";
import type * as React from "react";
import { useEffect, useRef } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { CommandMenu } from "@/components/command-menu";
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
import { totalDriftCounts } from "@/lib/format";
import type { Route } from "@/lib/router";
import { hrefFor, navigate } from "@/lib/router";
import type { OverviewResponse } from "@/lib/types";

const PRODUCT_NAME = "elf console";

function BrandMark(): React.ReactElement {
  return (
    <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted font-heading font-semibold text-[13px] text-muted-foreground">
      e
    </div>
  );
}

function UserFooter(): React.ReactElement {
  const { user } = useUser();
  const { signOut } = useClerk();
  if (!user) return <div />;
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
    <SidebarMenu>
      <SidebarMenuItem>
        <Menu>
          <MenuTrigger
            render={
              <SidebarMenuButton
                className="aria-expanded:bg-sidebar-accent aria-expanded:text-sidebar-accent-foreground"
                size="lg"
              />
            }
          >
            <Avatar className="size-8 rounded-lg">
              <AvatarImage alt={name} src={user.imageUrl} />
              <AvatarFallback className="rounded-lg text-[13px]">
                {initials || "?"}
              </AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left leading-tight">
              <span className="truncate font-medium text-[13px]">{name}</span>
              <span className="truncate text-muted-foreground text-[13px]">
                {email}
              </span>
            </div>
            <ChevronsUpDown className="ms-auto size-4" />
          </MenuTrigger>
          <MenuPopup align="start" className="min-w-56" side="top">
            <MenuItem onClick={() => void signOut()}>
              <LogOut />
              Sign out
            </MenuItem>
          </MenuPopup>
        </Menu>
      </SidebarMenuItem>
    </SidebarMenu>
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
  const viewLabel =
    route.view === "deprecations"
      ? "Deprecations"
      : route.view === "connections"
        ? "Connections"
        : null;
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

function DevUserBlock(): React.ReactElement {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          className="pointer-events-none"
          size="lg"
          tooltip="Local preview"
        >
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted font-medium text-muted-foreground text-[13px]">
            DV
          </div>
          <div className="grid flex-1 text-left leading-tight">
            <span className="truncate font-medium text-[13px]">Dev preview</span>
            <span className="truncate text-muted-foreground text-[13px]">
              Clerk bypass · local only
            </span>
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
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
    <SidebarProvider className="h-svh overflow-hidden bg-page p-2">
      <div className="flex h-full min-h-0 w-full overflow-hidden rounded-[12px] border bg-card shadow-shell [&>[data-slot=sidebar]]:min-w-0">
        <Sidebar
          className="static! h-full! min-w-0 overflow-hidden border-r border-sidebar-border [&_[data-slot=sidebar-gap]]:hidden group-data-[state=collapsed]:w-0 group-data-[state=collapsed]:border-r-0"
          collapsible="offcanvas"
        >
          <SidebarHeader>
          <div className="flex items-center gap-2.5 px-1 py-1.5">
            <BrandMark />
            <div className="grid min-w-0 flex-1 leading-tight">
              <span className="truncate font-heading font-semibold text-[13px]">
                {PRODUCT_NAME}
              </span>
              <span className="truncate text-muted-foreground text-[13px]">
                {overview.workspace.name}
              </span>
            </div>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
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
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {overview.projects.length === 0 ? (
                  <div className="px-2 py-1 text-muted-foreground text-[13px]">
                    No projects yet
                  </div>
                ) : (
                  <Collapsible className="group/projects" defaultOpen>
                    <SidebarMenuItem>
                      <CollapsibleTrigger
                        render={
                          <SidebarMenuButton isActive={route.name === "project"} />
                        }
                      >
                        <Boxes />
                        <span>Projects</span>
                        <ChevronDownIcon className="ms-auto size-4 text-muted-foreground transition-transform group-data-[open]/projects:rotate-180" />
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
                                  <Box className="size-3.5" />
                                  <span className="truncate">
                                    {project.name}
                                  </span>
                                  {driftCount > 0 ? (
                                    <span className="ms-auto shrink-0 text-warning-foreground text-[12px] tabular-nums">
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
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
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
        <SidebarFooter>
          {devMode ? <DevUserBlock /> : <UserFooter />}
        </SidebarFooter>
        </Sidebar>
        <SidebarInset className="min-h-0 min-w-0 flex-1 bg-card">
          <header className="relative z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-card px-3">
            <SidebarTrigger />
            <Separator className="me-1 data-[orientation=vertical]:h-4" orientation="vertical" />
            <Breadcrumbs overview={overview} route={route} />
            <div className="ms-auto flex items-center gap-2 sm:absolute sm:left-1/2 sm:top-1/2 sm:ms-0 sm:-translate-x-1/2 sm:-translate-y-1/2">
              <CommandMenu items={commandItems} />
            </div>
          </header>
          <div
            className="min-h-0 flex-1 overflow-y-auto bg-background px-4 py-6 sm:px-6 lg:px-8"
            ref={scrollRef}
          >
            <div className="mx-auto w-full max-w-6xl">{children}</div>
          </div>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
