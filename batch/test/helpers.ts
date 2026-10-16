import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BatchConfig, BridgeCaller } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = resolve(here, "fixtures");
export const FIXTURE_COMPONENTS = resolve(FIXTURES, "components");
export const FIXTURE_CYCLE = resolve(FIXTURES, "cycle");
export const FIXTURE_TOKENS = resolve(FIXTURES, "tokens.json");

export function fixtureConfig(overrides: Partial<BatchConfig> = {}): BatchConfig {
  return {
    configPath: resolve(FIXTURES, "elf-batch.config.json"),
    root: FIXTURES,
    tokensFile: FIXTURE_TOKENS,
    componentsDir: FIXTURE_COMPONENTS,
    manifestFile: resolve(FIXTURES, "elf.manifest.json"),
    modeStrategy: "modes",
    semanticModes: ["Light", "Dark"],
    chunkSize: 5,
    collections: { primitives: "Primitives", semantic: "Semantic" },
    ...overrides,
  };
}

/** A scratch copy of the component fixtures so tests can mutate freely. */
export interface Scratch {
  dir: string;
  componentsDir: string;
  config: BatchConfig;
  cleanup: () => void;
}

export function scratchFixtures(): Scratch {
  const dir = mkdtempSync(join(tmpdir(), "elf-batch-test-"));
  const componentsDir = join(dir, "components");
  cpSync(FIXTURE_COMPONENTS, componentsDir, { recursive: true });
  const config = fixtureConfig({
    root: dir,
    componentsDir,
    manifestFile: join(dir, "elf.manifest.json"),
  });
  return { dir, componentsDir, config, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface Call {
  method: string;
  params: Record<string, unknown>;
}

/**
 * Stands in for the BridgeClient: records every call, answers with plausible
 * Figma payloads, and fails whatever is listed in `failNames` or `failMethods`.
 */
export class FakeBridge implements BridgeCaller {
  readonly calls: Call[] = [];
  failNames = new Set<string>();
  failMethods = new Map<string, string>();
  /** Returned in upsert_variables' per-item `errors` (Figma-level refusals). */
  variableErrors: { name: string; message: string }[] = [];

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });

    const forced = this.failMethods.get(method);
    if (forced) throw new Error(forced);
    const name = typeof params.name === "string" ? params.name : "";
    if (name && this.failNames.has(name)) throw new Error(`simulated failure for ${name}`);

    switch (method) {
      case "create_collection":
        return { collection: { id: `C:${params.name}`, modes: [] }, created: true } as T;
      case "upsert_variables": {
        const variables = (params.variables as { name: string }[]) ?? [];
        return {
          collection: { variableCount: variables.length },
          variables: variables.map((variable, index) => ({
            id: `V:${index}`,
            name: variable.name,
            action: "created",
          })),
          errors: this.variableErrors,
        } as T;
      }
      case "upsert_component":
        return { component: { id: `CO:${this.calls.length}`, created: true } } as T;
      case "upsert_component_set":
        return { set: { id: `CS:${this.calls.length}`, created: true } } as T;
      case "upsert_text_style":
        return { style: { id: `TS:${this.calls.length}`, created: true } } as T;
      case "upsert_effect_style":
        return { style: { id: `ES:${this.calls.length}`, created: true } } as T;
      case "get_node":
        return {
          node: {
            id: params.nodeId,
            name: "Fake",
            type: "COMPONENT",
            codeKey: null,
            layoutMode: "NONE",
            width: 100,
            height: 40,
            x: 10,
            y: 20,
            itemSpacing: 0,
            paddingTop: 0,
            paddingRight: 0,
            paddingBottom: 0,
            paddingLeft: 0,
            cornerRadius: 0,
            fills: [],
            boundVariables: {},
            children: [],
          },
        } as T;
      default:
        throw new Error(`FakeBridge has no handler for "${method}".`);
    }
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }

  callsTo(method: string): Call[] {
    return this.calls.filter((call) => call.method === method);
  }

  componentNames(method: string): string[] {
    return this.callsTo(method).map((call) => String(call.params.name));
  }
}
