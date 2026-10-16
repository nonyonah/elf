import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { orderComponents } from "../src/graph.js";
import { parseComponents } from "../src/parser.js";
import { FIXTURE_COMPONENTS, FIXTURE_CYCLE } from "./helpers.js";

describe("dependency graph", () => {
  test("orders leaves first, deterministically", () => {
    const order = orderComponents(parseComponents(FIXTURE_COMPONENTS));
    assert.deepEqual(
      order.map((component) => component.name),
      ["Badge", "Card", "Divider", "Footer", "Icon", "Alert", "Button", "Status"],
    );
  });

  test("every dependency precedes its dependent", () => {
    const order = orderComponents(parseComponents(FIXTURE_COMPONENTS));
    const index = new Map(order.map((component, position) => [component.codeKey, position]));
    for (const component of order) {
      for (const dependency of component.dependencies) {
        assert.ok(
          (index.get(dependency) ?? -1) < (index.get(component.codeKey) ?? -1),
          `${dependency} must come before ${component.codeKey}`,
        );
      }
    }
  });

  test("a cycle fails loudly, naming the members", () => {
    const parsed = parseComponents(FIXTURE_CYCLE);
    assert.throws(() => orderComponents(parsed), /Dependency cycle among: .*A.*B|Dependency cycle among: .*B.*A/);
  });

  test("dependencies outside the subset are ignored (for --only)", () => {
    const parsed = parseComponents(FIXTURE_COMPONENTS);
    const justButton = parsed.filter((component) => component.name === "Button");
    const order = orderComponents(justButton);
    assert.deepEqual(order.map((component) => component.name), ["Button"]);
  });
});
