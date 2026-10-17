import { useClerk, useUser } from "@clerk/react";
import {
  Box,
  ChevronRight,
  ChevronsUpDown,
  LayoutDashboard,
  LogOut,
  RefreshCw,
} from "lucide-react";
import type * as React from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
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
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { formatRelative, totalDriftCounts } from "@/lib/format";
import type { Route } from "@/lib/router";
import { hrefFor } from "@/lib/router";
import type { OverviewResponse } from "@/lib/types";

const PRODUCT_NAME = "elf console";

function BrandMark(): React.ReactElement {
  return (
    <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary font-heading font-semibold text-primary-foreground text-sm">
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
              <AvatarFallback className="rounded-lg text-xs">
                {initials || "?"}
              </AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left leading-tight">
              <span className="truncate font-medium text-sm">{name}</span>
              <span className="truncate text-muted-foreground text-xs">
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
    return <span className="font-medium text-sm">Overview</span>;
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
        className="text-muted-foreground text-sm hover:text-foreground"
        href="#/"
      >
        Projects
      </a>
      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />
      <a
        className={
          viewLabel
            ? "truncate text-muted-foreground text-sm hover:text-foreground"
            : "truncate font-medium text-sm"
        }
        href={hrefFor({ name: "project", projectId: route.projectId, view: "overview" })}
      >
        {project?.name ?? "Project"}
      </a>
      {viewLabel ? (
        <>
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />
          <span className="truncate font-medium text-sm">{viewLabel}</span>
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
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted font-medium text-muted-foreground text-xs">
            DV
          </div>
          <div className="grid flex-1 text-left leading-tight">
            <span className="truncate font-medium text-sm">Dev preview</span>
            <span className="truncate text-muted-foreground text-xs">
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
  onRefresh,
  refreshing,
  devMode = false,
  children,
}: {
  overview: OverviewResponse;
  route: Route;
  onRefresh: () => void;
  refreshing: boolean;
  devMode?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <div className="flex items-center gap-2.5 px-1 py-1.5">
            <BrandMark />
            <div className="grid min-w-0 flex-1 leading-tight group-data-[collapsible=icon]:hidden">
              <span className="truncate font-heading font-semibold text-sm">
                {PRODUCT_NAME}
              </span>
              <span className="truncate text-muted-foreground text-xs">
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
            <SidebarGroupLabel>Projects</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {overview.projects.length === 0 ? (
                  <div className="px-2 py-1 text-muted-foreground text-xs group-data-[collapsible=icon]:hidden">
                    No projects yet
                  </div>
                ) : null}
                {overview.projects.map((project) => {
                  const driftCount = totalDriftCounts(project.counts);
                  const isActive =
                    route.name === "project" && route.projectId === project.id;
                  return (
                    <SidebarMenuItem key={project.id}>
                      <SidebarMenuButton
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
                        tooltip={project.name}
                      >
                        <Box />
                        <span className="truncate">{project.name}</span>
                      </SidebarMenuButton>
                      {driftCount > 0 ? (
                        <SidebarMenuBadge className="text-warning-foreground">
                          {driftCount}
                        </SidebarMenuBadge>
                      ) : null}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          {devMode ? <DevUserBlock /> : <UserFooter />}
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur">
          <SidebarTrigger />
          <Separator className="me-1 data-[orientation=vertical]:h-4" orientation="vertical" />
          <Breadcrumbs overview={overview} route={route} />
          <div className="ms-auto flex items-center gap-2">
            <span className="hidden text-muted-foreground text-xs sm:block">
              Checked {formatRelative(overview.summary.lastCheckedAt)}
            </span>
            <Button
              aria-label="Refresh"
              disabled={refreshing}
              onClick={onRefresh}
              size="icon-sm"
              variant="ghost"
            >
              <RefreshCw className={refreshing ? "animate-spin" : undefined} />
            </Button>
          </div>
        </header>
        <div className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
