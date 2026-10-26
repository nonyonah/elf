import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load KEY=VALUE pairs into the environment without overriding variables that
 * already exist. A real shell variable beats a file, and a missing file is fine.
 */
export function loadDotEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (env[key] !== undefined) continue;
    let value = line.slice(separator + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);
    env[key] = value;
  }
}

/**
 * Load local Slack settings from the project folder and the bundled settings UI.
 * Shell environment always wins.
 */
export function loadSettingsEnv(configPath: string): void {
  const projectDir = dirname(resolve(configPath));
  loadDotEnvFile(join(projectDir, ".env"));
  loadDotEnvFile(join(projectDir, ".env.local"));

  const settingsDir = fileURLToPath(new URL("../settings-next", import.meta.url));
  loadDotEnvFile(join(settingsDir, ".env"));
  loadDotEnvFile(join(settingsDir, ".env.local"));
}
