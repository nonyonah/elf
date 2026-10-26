export type Category = "color" | "spacing" | "typography" | "radius" | "shadow";

export interface Token {
  name: string;
  category: Category;
  value: string;
  source: "figma" | "code";
  /** Set when comparing every mode ("all") or a list: Light, Dark, … */
  mode?: string;
}

export type FigmaSource = "auto" | "variables" | "styles" | "bridge";

export type CodebaseSource = "auto" | "tailwind" | "css" | "tokens-json";

/** How variable collections turn into modes. */
export type ModeStrategy = "modes" | "collections";

/** `"all"` compares every mode; an array compares the named modes. */
export type ModeName = string | string[] | null;

export type DeprecationType = "token" | "component";

/** One entry of the config's `deprecations` allowlist. */
export interface Deprecation {
  /** Token name as reported (post nameMapping), or component name/codeKey. */
  name: string;
  type: DeprecationType;
  reason?: string;
  /** YYYY-MM-DD; informational. */
  since?: string;
  /** YYYY-MM-DD; once in the past, the item counts as drift. */
  removeBy?: string;
}

/** Where the component side of the sync lives (written by elf-batch). */
export interface ComponentsConfig {
  /** Folder holding component files + sidecars. */
  path: string;
  /** Discovered source files, relative to path. */
  files?: string[];
  /** Path to elf.manifest.json — the code↔Figma map. */
  manifest: string;
}

/** Where drift alerts go when `--notify` is passed. The URL itself lives in the environment. */
export interface NotifyConfig {
  /** Name of the environment variable holding the webhook URL — never the URL. */
  webhookEnv: string;
  /** `"slack"` posts Block Kit JSON (Slack, or Discord with a `/slack` suffix); `"text"` posts a plain body (e.g. ntfy). */
  format: "slack" | "text";
  /** When false, notify after every run instead of only when the drift fingerprint changes. Defaults to true. */
  onlyOnChange?: boolean;
  /** Optional file for the dedupe state; defaults to .elf/notify-state.json next to the report. */
  stateFile?: string;
  /** Optional absolute URL to the full report, used for Slack's "see the full report" link. */
  reportUrl?: string;
}

/** Where snapshots go: the elf console dashboard. The token lives in the ELF_DASHBOARD_TOKEN environment variable, never here. */
export interface DashboardConfig {
  url: string;
  /** Optional project slug/id from the console — kept for links and future use. */
  projectId?: string;
}

export interface DriftConfig {
  figma: {
    fileKey: string;
    apiTokenEnv: string;
    source: FigmaSource;
    teamId?: string;
  };
  codebase: {
    path: string;
    source: CodebaseSource;
    /** Automatically discovered token source files. */
    paths?: string[];
  };
  modeName: ModeName;
  modeStrategy: ModeStrategy;
  nameMapping: Record<string, string>;
  /** Opt-in component diff; absent means tokens only. */
  components?: ComponentsConfig;
  deprecations: Deprecation[];
  /** Exact token value pairs accepted temporarily; unrelated changes still drift. */
  intentionalDifferences?: {name: string; mode?: string; figmaValue: string; codeValue: string; reason: string; expires?: string}[];
  /** Opt-in drift alerts; used when the CLI runs with `--notify`. */
  notify?: NotifyConfig;
  /** Opt-in snapshot pushes; used by `elf push`. */
  dashboard?: DashboardConfig;
  webhook?: {
    endpoint?: string;
    eventTypes?: string[];
    passcodeEnv?: string;
  };
}
