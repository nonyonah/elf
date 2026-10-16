import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ComponentsConfig, Deprecation, DriftConfig, ModeStrategy, NotifyConfig } from "./types.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function loadConfig(configPath: string): DriftConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(configPath), "utf8"));
  } catch (error) {
    throw new Error(`Could not read config "${configPath}": ${(error as Error).message}`);
  }

  const config = raw as Partial<DriftConfig>;
  const configDir = dirname(resolve(configPath));

  if (!config.figma?.fileKey) {
    throw new Error(`Config "${configPath}" is missing "figma.fileKey".`);
  }
  if (!config.codebase?.path) {
    throw new Error(`Config "${configPath}" is missing "codebase.path".`);
  }

  return {
    figma: {
      fileKey: config.figma.fileKey,
      apiTokenEnv: config.figma.apiTokenEnv ?? "FIGMA_API_TOKEN",
      source: config.figma.source ?? "auto",
      teamId: config.figma.teamId ?? "",
    },
    codebase: {
      path: config.codebase.path,
      source: config.codebase.source ?? "auto",
    },
    modeName: config.modeName ?? null,
    modeStrategy: parseModeStrategy(config.modeStrategy),
    nameMapping: config.nameMapping ?? {},
    components: parseComponents(config.components, configDir, configPath),
    deprecations: parseDeprecations(config.deprecations, configPath),
    notify: parseNotify(config.notify, configDir, configPath),
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
  if (record.stateFile !== undefined && (typeof record.stateFile !== "string" || !record.stateFile.trim())) {
    throw new Error(`Config "${configPath}": "notify.stateFile" must be a non-empty path.`);
  }
  return {
    webhookEnv: record.webhookEnv.trim(),
    format,
    ...(typeof record.stateFile === "string" ? { stateFile: resolve(configDir, record.stateFile) } : {}),
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
