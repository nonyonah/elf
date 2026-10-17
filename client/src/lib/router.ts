import * as React from "react";

export type ProjectView = "overview" | "deprecations" | "connections";

export type Route =
  | { name: "overview" }
  | { name: "project"; projectId: string; view: ProjectView };

export function parseHash(hash: string): Route {
  const segments = hash.replace(/^#/, "").split("/").filter(Boolean);
  if (segments[0] === "p" && segments[1]) {
    const view = segments[2];
    return {
      name: "project",
      projectId: decodeURIComponent(segments[1]),
      view:
        view === "deprecations" || view === "connections" ? view : "overview",
    };
  }
  return { name: "overview" };
}

export function hrefFor(route: Route): string {
  if (route.name === "overview") return "#/";
  const base = `#/p/${encodeURIComponent(route.projectId)}`;
  return route.view === "overview" ? base : `${base}/${route.view}`;
}

export function navigate(route: Route): void {
  window.location.hash = hrefFor(route);
}

export function useRoute(): Route {
  const [hash, setHash] = React.useState(() => window.location.hash);
  React.useEffect(() => {
    const onChange = (): void => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return parseHash(hash);
}
