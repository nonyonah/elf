import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BatchConfig, BridgeCaller } from "../../batch/src/types.js";

export interface Scratch {
  dir: string;
  config: BatchConfig;
  cleanup: () => void;
}

const TOKENS = {
  color: {
    primary: { "500": { value: "#6366f1", type: "color" } },
    surface: { base: { value: "#ffffff", type: "color" } },
  },
  space: {
    "2": { value: 8, type: "dimension" },
    "4": { value: 16, type: "dimension" },
  },
};

const BUTTON = `import Icon from "./Icon";

export interface ButtonProps {
  label?: string;
}

export default function Button({ label }: ButtonProps) {
  return <button><Icon />{label}</button>;
}
`;

const ICON = `export interface IconProps {
  name?: string;
}

export default function Icon({ name = "star" }: IconProps) {
  return <svg aria-label={name} />;
}
`;

const BUTTON_SIDECAR = {
  gap: "space.2",
  padding: { all: "space.4" },
  fill: "color.primary.500",
  children: [{ type: "instance", component: "Icon.tsx#Icon" }],
};

const ICON_SIDECAR = {
  size: { width: 16, height: 16 },
  fill: "color.surface.base",
};

/** A complete consumer project in a temp directory, with no repo fixtures. */
export function scratchProject(): Scratch {
  const dir = mkdtempSync(join(tmpdir(), "elf-watch-test-"));
  const components = join(dir, "components");
  mkdirSync(components, { recursive: true });
  writeFileSync(join(dir, "tokens.json"), `${JSON.stringify(TOKENS, null, 2)}\n`);
  writeFileSync(join(dir, "elf-batch.config.json"), `${JSON.stringify({
    tokens: "tokens.json",
    components: "components",
    manifest: "elf.manifest.json",
    chunkSize: 1,
  }, null, 2)}\n`);
  writeFileSync(join(components, "Button.tsx"), BUTTON);
  writeFileSync(join(components, "Button.figma.json"), `${JSON.stringify(BUTTON_SIDECAR, null, 2)}\n`);
  writeFileSync(join(components, "Icon.tsx"), ICON);
  writeFileSync(join(components, "Icon.figma.json"), `${JSON.stringify(ICON_SIDECAR, null, 2)}\n`);

  const config: BatchConfig = {
    configPath: join(dir, "elf-batch.config.json"),
    root: dir,
    tokensFile: join(dir, "tokens.json"),
    componentsDir: components,
    manifestFile: join(dir, "elf.manifest.json"),
    modeStrategy: "modes",
    semanticModes: ["Light", "Dark"],
    chunkSize: 1,
    collections: { primitives: "Primitives", semantic: "Semantic" },
  };

  return {
    dir,
    config,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function writeSidecar(scratch: Scratch, name: string, value: unknown): void {
  writeFileSync(join(scratch.config.componentsDir, `${name}.figma.json`), `${JSON.stringify(value, null, 2)}\n`);
}

export function writeTokens(scratch: Scratch, value: unknown): void {
  writeFileSync(scratch.config.tokensFile, `${JSON.stringify(value, null, 2)}\n`);
}

export interface Call {
  method: string;
  params: Record<string, unknown>;
}

/** Fake bridge with mutable node state so conflict tests can change Figma. */
export class FakeBridge implements BridgeCaller {
  readonly calls: Call[] = [];
  readonly codeKeys = new Map<string, string>();
  readonly missingNodes = new Set<string>();
  nodeWidth = 100;

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
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
          errors: [],
        } as T;
      }
      case "upsert_component": {
        const id = `CO:${this.calls.length}`;
        if (params.codeKey) this.codeKeys.set(id, String(params.codeKey));
        return { component: { id, created: true } } as T;
      }
      case "upsert_component_set": {
        const id = `CS:${this.calls.length}`;
        if (params.codeKey) this.codeKeys.set(id, String(params.codeKey));
        return { set: { id, created: true } } as T;
      }
      case "upsert_text_style":
        return { style: { id: `TS:${this.calls.length}`, created: true } } as T;
      case "upsert_effect_style":
        return { style: { id: `ES:${this.calls.length}`, created: true } } as T;
      case "get_node": {
        if (this.missingNodes.has(String(params.nodeId))) {
          throw new Error(`Node ${params.nodeId} not found in this file.`);
        }
        return {
          node: {
            id: params.nodeId,
            name: params.nodeId,
            type: "COMPONENT",
            codeKey: this.codeKeys.get(String(params.nodeId)) ?? null,
            width: this.nodeWidth,
            height: 40,
            x: 0,
            y: 0,
            fills: [],
            children: [],
          },
        } as T;
      }
      default:
        throw new Error(`FakeBridge has no handler for "${method}".`);
    }
  }

  callsTo(method: string): Call[] {
    return this.calls.filter((call) => call.method === method);
  }

  componentNames(method: string): string[] {
    return this.callsTo(method).map((call) => String(call.params.name));
  }
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
  intervalMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`);
}
