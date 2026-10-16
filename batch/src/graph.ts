import type { ParsedComponent } from "./types.js";

/**
 * Kahn's algorithm over the dependency edges, with every ready-set sorted by
 * name — so the order (and therefore the chunking) is identical on every run.
 * Cycles fail loudly: syncing a cycle would mean syncing components whose
 * sources do not exist yet.
 */
export function orderComponents(components: ParsedComponent[]): ParsedComponent[] {
  const byKey = new Map(components.map((component) => [component.codeKey, component]));

  const remaining = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const component of components) {
    const deps = component.dependencies.filter((dependency) => byKey.has(dependency));
    remaining.set(component.codeKey, deps.length);
    for (const dep of deps) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), component.codeKey]);
    }
  }

  const ready = components
    .filter((component) => remaining.get(component.codeKey) === 0)
    .sort(byName);
  const order: ParsedComponent[] = [];

  while (ready.length > 0) {
    const next = ready.shift() as ParsedComponent;
    order.push(next);
    for (const dependent of dependents.get(next.codeKey) ?? []) {
      const count = (remaining.get(dependent) as number) - 1;
      remaining.set(dependent, count);
      if (count === 0) {
        insertSorted(ready, byKey.get(dependent) as ParsedComponent, byName);
      }
    }
  }

  if (order.length !== components.length) {
    const stuck = components
      .filter((component) => !order.includes(component))
      .map((component) => `${component.name} (${component.file})`);
    throw new Error(
      `Dependency cycle among: ${stuck.join(", ")}. ` +
        `Break the cycle — components must form a DAG (leaves first).`,
    );
  }

  return order;
}

function byName(a: ParsedComponent, b: ParsedComponent): number {
  return a.name.localeCompare(b.name) || a.codeKey.localeCompare(b.codeKey);
}

function insertSorted(list: ParsedComponent[], component: ParsedComponent, compare: (a: ParsedComponent, b: ParsedComponent) => number): void {
  const index = list.findIndex((candidate) => compare(component, candidate) < 0);
  if (index === -1) list.push(component);
  else list.splice(index, 0, component);
}
