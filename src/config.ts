import { discoverProject, readSource } from "./discovery.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import type { ComponentsConfig, DashboardConfig, Deprecation, DriftConfig, ModeStrategy, NotifyConfig } from "./core/types.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Find the nearest elf.config.json walking up from a directory.
 * Lets commands work from nested folders such as `settings-next/`.
 */
export function findConfigPath(startDir = process.cwd()): string | null {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, "elf.config.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadConfig(configPath: string): DriftConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(configPath), "utf8"));
  } catch (error) {
    throw new Error(`Could not read config "${configPath}": ${(error as Error).message}`);
  }

  const config = raw as Partial<DriftConfig> & { sync?: { components?: string; manifest?: string } };
  const configDir = dirname(resolve(configPath));
  const components = config.components || config.sync?.components ? {
    ...config.components,
    ...(config.sync?.components ? {path: config.sync.components} : {}),
    manifest: config.sync?.manifest ?? config.components?.manifest ?? "elf.manifest.json",
  } : undefined;

  if (!config.figma?.fileKey) {
    throw new Error(`Config "${configPath}" is missing "figma.fileKey".`);
  }
  const autoTokens = !config.codebase?.path || config.codebase.path === "auto";
  const discovered = autoTokens || !components ? discoverProject(configDir) : undefined;
  // Elf-created root imports supplement explicit legacy token paths as well.
  const importedPaths = readdirSync(configDir,{withFileTypes:true}).filter(item => item.isFile() && /^[A-Za-z0-9][A-Za-z0-9._-]*\.tokens\.json$/.test(item.name)).map(item => join(configDir,item.name)).filter(path => {
    const content=readSource(path);
    if (!content.includes('"$elfFigmaImport"')) return false;
    return JSON.parse(content).$elfFigmaImport===1;
  });
  const componentConfig = components ?? (discovered?.componentRoot ? {
    path: discovered.componentRoot, manifest: config.sync?.manifest ?? "elf.manifest.json",
    files: discovered.components.map(path => relative(discovered.componentRoot!, path)),
  } : undefined);

  return {
    figma: {
      fileKey: config.figma.fileKey,
      ...(importedPaths.length ? {collectionAwareNames:true} : {}),
      authorization: config.figma.authorization === "plugin" ? "plugin" : "strict",
      apiTokenEnv: config.figma.apiTokenEnv ?? "FIGMA_API_TOKEN",
      source: config.figma.authorization === 'plugin' || importedPaths.length ? 'bridge' : config.figma.source ?? "auto",
      teamId: config.figma.teamId ?? "",
    },
    codebase: {
      path: autoTokens ? discovered!.tokens[0] ?? resolve(configPath) : config.codebase!.path,
      source: autoTokens ? "auto" : config.codebase!.source ?? "auto",
      ...(autoTokens ? {paths: [...new Set([...discovered!.tokens,...importedPaths])]} : importedPaths.length ? {paths:[...new Set([resolve(configDir,config.codebase!.path),...importedPaths])]} : {}),
    },
    modeName: config.modeName ?? null,
    modeStrategy: parseModeStrategy(config.modeStrategy),
    nameMapping: config.nameMapping ?? {},
    components: parseComponents(componentConfig, configDir, configPath),
    intentionalDifferences: parseIntentionalDifferences(config.intentionalDifferences),
    deprecations: parseDeprecations(config.deprecations, configPath),
    notify: parseNotify(config.notify, configDir, configPath),
    dashboard: parseDashboard(config.dashboard, configPath),
    webhook: {
      endpoint: config.webhook?.endpoint ?? "",
      eventTypes: config.webhook?.eventTypes ?? [],
      passcodeEnv: config.webhook?.passcodeEnv ?? "FIGMA_WEBHOOK_PASSCODE",
    },
  };
}

function parseModeStrategy(value: unknown): ModeStrategy {
  if (value === undefined) return "modes";
  if (value === "modes" || value === "collections") return value;
  throw new Error(`"modeStrategy" must be "modes" or "collections", got ${JSON.stringify(value)}.`);
}

/** Component paths are resolved against the config file's folder, like elf-batch. */
function parseComponents(value: unknown, configDir: string, configPath: string): ComponentsConfig | undefined {
  if (value === undefined || value === null) return undefined;
  const record = value as Partial<ComponentsConfig>;
  if (typeof record.path !== "string" || !record.path) {
    throw new Error(`Config "${configPath}": "components" needs a "path" (the components folder).`);
  }
  if (typeof record.manifest !== "string" || !record.manifest) {
    throw new Error(`Config "${configPath}": "components" needs a "manifest" (path to elf.manifest.json).`);
  }
  return {
    path: resolve(configDir, record.path),
    ...(Array.isArray(record.files) ? {files: record.files} : {}),
    manifest: resolve(configDir, record.manifest),
  };
}

function parseNotify(value: unknown, configDir: string, configPath: string): NotifyConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Config "${configPath}": "notify" must be an object.`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.webhookEnv !== "string" || !record.webhookEnv.trim()) {
    throw new Error(
      `Config "${configPath}": "notify" needs "webhookEnv" — the name of the environment variable holding the webhook URL.`,
    );
  }
  const format = record.format ?? "slack";
  if (format !== "slack" && format !== "text") {
    throw new Error(`Config "${configPath}": "notify.format" must be "slack" or "text", got ${JSON.stringify(record.format)}.`);
  }
  if (record.onlyOnChange !== undefined && typeof record.onlyOnChange !== "boolean") {
    throw new Error(`Config "${configPath}": "notify.onlyOnChange" must be a boolean.`);
  }
  if (record.stateFile !== undefined && (typeof record.stateFile !== "string" || !record.stateFile.trim())) {
    throw new Error(`Config "${configPath}": "notify.stateFile" must be a non-empty path.`);
  }
  if (record.reportUrl !== undefined) {
    if (typeof record.reportUrl !== "string" || !/^https?:\/\//i.test(record.reportUrl.trim())) {
      throw new Error(`Config "${configPath}": "notify.reportUrl" must be an http(s) URL.`);
    }
  }
  return {
    webhookEnv: record.webhookEnv.trim(),
    format,
    onlyOnChange: record.onlyOnChange ?? true,
    ...(typeof record.stateFile === "string" ? { stateFile: resolve(configDir, record.stateFile) } : {}),
    ...(typeof record.reportUrl === "string" ? { reportUrl: record.reportUrl.trim() } : {}),
  };
}

function parseDashboard(value: unknown, configPath: string): DashboardConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Config "${configPath}": "dashboard" must be an object.`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.url !== "string" || !record.url.trim()) {
    throw new Error(`Config "${configPath}": "dashboard" needs a "url" (the elf console base URL).`);
  }
  if (record.projectId !== undefined && (typeof record.projectId !== "string" || !record.projectId.trim())) {
    throw new Error(`Config "${configPath}": "dashboard.projectId" must be a non-empty string when set.`);
  }
  return {
    url: record.url.trim().replace(/\/+$/, ""),
    ...(typeof record.projectId === "string" ? { projectId: record.projectId.trim() } : {}),
  };
}

function parseDeprecations(value: unknown, configPath: string): Deprecation[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Config "${configPath}": "deprecations" must be an array.`);
  }

  return value.map((entry, index) => {
    const label = `deprecations[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`Config "${configPath}": ${label} must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    const name = record.name;
    if (typeof name !== "string" || !name.trim()) {
      throw new Error(`Config "${configPath}": ${label} needs a non-empty "name".`);
    }
    if (record.type !== "token" && record.type !== "component") {
      throw new Error(`Config "${configPath}": ${label} needs "type": "token" or "component".`);
    }
    for (const key of ["reason", "since", "removeBy"] as const) {
      const dateValue = record[key];
      if (dateValue === undefined) continue;
      if (typeof dateValue !== "string" || (key !== "reason" && !DATE_RE.test(dateValue))) {
        throw new Error(
          key === "reason"
            ? `Config "${configPath}": ${label}.reason must be a string.`
            : `Config "${configPath}": ${label}.${key} must be a YYYY-MM-DD date.`,
        );
      }
    }
    return {
      name: name.trim(),
      type: record.type as Deprecation["type"],
      ...(record.reason === undefined ? {} : { reason: String(record.reason) }),
      ...(record.since === undefined ? {} : { since: String(record.since) }),
      ...(record.removeBy === undefined ? {} : { removeBy: String(record.removeBy) }),
    };
  });
}

function parseIntentionalDifferences(value: unknown): DriftConfig["intentionalDifferences"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("intentionalDifferences must be an array.");
  for (const item of value) {
    if (!item || ["name", "figmaValue", "codeValue", "reason"].some(key => typeof item[key] !== "string" || !item[key].trim()) || (item.mode !== undefined && typeof item.mode !== "string") || (item.expires !== undefined && (typeof item.expires !== "string" || !DATE_RE.test(item.expires) || (!Number.isFinite(Date.parse(item.expires)) || new Date(item.expires).toISOString().slice(0, 10) !== item.expires)))) throw new Error("Each intentional difference needs a name, exact Figma and code values, a reason, and an optional expiry date.");
  }
  return value;
}
