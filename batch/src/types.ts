// ---------------------------------------------------------------------------
// Shared types for the batch pipeline.
//
// The vocabulary, top to bottom: a config points at a tokens file and a
// components folder; the parser turns components into ParsedComponents, the
// sidecars into Specs; tokens + specs + the dependency graph become a Plan;
// the sync executes the plan through the bridge and records what happened in
// the manifest.
// ---------------------------------------------------------------------------

export type ModeStrategy = "modes" | "collections";

/** `elf-batch.config.json`, with paths already resolved to absolutes. */
export interface BatchConfig {
  /** Path to the config file, for error messages. */
  configPath: string;
  /** Project root everything is relative to (the config file's folder). */
  root: string;
  tokensFile: string;
  componentsDir: string;
  manifestFile: string;
  modeStrategy: ModeStrategy;
  /** Figma mode names used for the semantic collection(s). */
  semanticModes: string[];
  /** Component chunk size — the manifest is written after every chunk. */
  chunkSize: number;
  collections: {
    primitives: string;
    semantic: string;
  };
}

/** One entry of the sidecar's `variants` map, keyed by "size=sm, intent=primary". */
export interface SidecarVariant {
  layoutMode?: string;
  padding?: Record<string, unknown>;
  gap?: unknown;
  cornerRadius?: unknown;
  fill?: unknown;
  size?: { width?: number; height?: number };
  text?: Record<string, unknown>;
  children?: unknown[];
}

/** The parsed `<Name>.figma.json` — still in token-reference form. */
export interface SidecarSpec {
  layoutMode?: string;
  padding?: Record<string, unknown>;
  gap?: unknown;
  cornerRadius?: unknown;
  fill?: unknown;
  size?: { width?: number; height?: number };
  text?: Record<string, unknown>;
  children?: unknown[];
  variants?: Record<string, SidecarVariant>;
}

/** What the parser found in a component file, whatever the framework. */
export interface ParsedComponent {
  /** Component name — the file's basename in v1. */
  name: string;
  /** `<relative/path.tsx>#<Name>` — the stable identity across runs. */
  codeKey: string;
  /** POSIX path relative to the components folder. */
  file: string;
  /** String-literal-union props, in declaration order. */
  variantProps: { name: string; values: string[] }[];
  /** codeKeys of sibling components this file imports. */
  dependencies: string[];
}

/** The full variant matrix: cartesian product of the variant props. */
export interface Variant {
  /** e.g. `{ size: "sm", intent: "primary" }` */
  props: Record<string, string>;
  /** e.g. `size=sm, intent=primary` — exactly what Figma names the variant. */
  label: string;
}

/** A component with its sidecar resolved into plugin-call parameters. */
export interface PlannedComponent {
  parsed: ParsedComponent;
  /** Raw sidecar (kept for hashing), or null when the file is missing. */
  sidecar: SidecarSpec | null;
  /** Sidecar read/resolve error — the component counts as failed. */
  sidecarError?: string;
  /** set-level call params (tokens already resolved), for upsert_component_set. */
  setParams?: Record<string, unknown>;
  /** per-variant overrides, keyed by variant label. */
  variantParams?: Record<string, Record<string, unknown>>;
  /** plugin-call params for a plain component (upsert_component). */
  params?: Record<string, unknown>;
  /** The variant matrix, in declaration order; [] for plain components. */
  variants: Variant[];
}

/** One variable to upsert, with its Figma name and per-mode values. */
export interface PlannedVariable {
  /** Dotted token path, e.g. `color.primary.500` — also the codeKey. */
  codeKey: string;
  /** Figma variable name, e.g. `color/primary/500`. */
  name: string;
  type: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
  scopes?: string[];
  /** Mode name → literal or { variable: figma-name } alias. */
  values: Record<string, unknown>;
}

export interface PlannedTextStyle {
  key: string;
  params: Record<string, unknown>;
}

export interface PlannedEffectStyle {
  key: string;
  params: Record<string, unknown>;
}

/** Everything the tokens file turns into, split per collection. */
export interface TokensPlan {
  primitives: { collection: string; modes: string[]; variables: PlannedVariable[] };
  semantic: { collection: string; modes: string[]; variables: PlannedVariable[] };
  /** collections strategy: one semantic collection per mode instead of modes. */
  semanticCollections?: { collection: string; mode: string; variables: PlannedVariable[] }[];
  textStyles: PlannedTextStyle[];
  effectStyles: PlannedEffectStyle[];
}

/** The whole run, in execution order. */
export interface Plan {
  tokens: TokensPlan;
  components: PlannedComponent[];
}

// ---------------------------------------------------------------------------
// Manifest — `elf.manifest.json`, commit-friendly, stable key order.
// ---------------------------------------------------------------------------

export type ComponentStatus = "pending" | "synced" | "failed" | "skipped";

export interface ManifestComponent {
  figmaNodeId: string | null;
  specHash: string;
  /** nodeStateHash of the node right after the last sync — absent in older manifests. */
  nodeHash?: string | null;
  status: ComponentStatus;
  updatedAt: string;
  error?: string;
}

export interface ManifestToken {
  figmaVariableId: string | null;
  valueHash: string;
}

export interface Manifest {
  version: 1;
  components: Record<string, ManifestComponent>;
  tokens: Record<string, ManifestToken>;
}

/** The narrow slice of the bridge client the sync needs (easy to fake). */
export interface BridgeCaller {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}
