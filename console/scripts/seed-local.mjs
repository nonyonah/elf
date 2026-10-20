#!/usr/bin/env node
/**
 * Seeds a local-preview demo project so every console screen has data.
 *
 * Prerequisites: `wrangler dev` is running (:8787) with DEV_ONLY_FAKE_USER set
 * (see .dev.vars) and the local D1 migrated (`npm run db:local`).
 *
 * The script is idempotent: it resets the demo project's snapshots, drift runs
 * and deprecations, then re-seeds them. It only ever touches the fixed demo
 * ids — your own projects are untouched.
 *
 *   node scripts/seed-local.mjs [--base http://127.0.0.1:8787]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const baseFlag = args.indexOf("--base");
const BASE =
  baseFlag > -1 && args[baseFlag + 1]
    ? args[baseFlag + 1]
    : (process.env.SEED_BASE ?? "http://127.0.0.1:8787");

const DB = "elf-console";
const PROJECT_NAME = "Marketing site";
const FIGMA_FILE_KEY = "LOCALDEMOKEY01";
const FIGMA_FILE_NAME = "Elf Demo — Design System";

// Deterministic local-only tokens (never usable anywhere but this machine).
const PUSH_TOKEN = "elf_push_local_preview_0001";
const PLUGIN_TOKEN = "elf_plugin_local_preview_0001";

function sql(statement) {
  const output = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", DB, "--local", "--command", statement],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return output;
}

async function api(path, { method = "GET", token, body } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    throw new Error(
      `${method} ${path} → ${response.status}: ${text.slice(0, 300)}`,
    );
  }
  return json;
}

const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

const daysAgoDate = (days) =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const daysAgoIso = (days) =>
  new Date(Date.now() - days * 86_400_000).toISOString();

const color = (name, value) => ({ name, value, category: "color" });
const spacing = (name, value) => ({ name, value, category: "spacing" });

const FIGMA_TOKENS = [
  color("color.brand.primary", "#0F62FE"),
  color("color.brand.on-primary", "#FFFFFF"),
  color("color.surface.base", "#FAFAFA"),
  color("color.accent.mint", "#6EE7B7"),
  spacing("spacing.sm", "8px"),
  spacing("spacing.md", "16px"),
  { name: "radius.md", value: "8px", category: "radius" },
  { name: "type.body.font-size", value: "16px", category: "typography" },
  { name: "type.body.line-height", value: "24px", category: "typography" },
];

const CODE_TOKENS = [
  color("color.brand.primary", "#0E5ADB"),
  color("color.brand.on-primary", "#FFFFFF"),
  color("color.surface.base", "#FAFAFA"),
  spacing("spacing.sm", "8px"),
  spacing("spacing.md", "16px"),
  spacing("spacing.xl", "48px"),
  { name: "radius.md", value: "8px", category: "radius" },
  { name: "type.body.font-size", value: "16px", category: "typography" },
  { name: "type.body.line-height", value: "28px", category: "typography" },
  color("color.brand.legacy", "#9CA3AF"),
  color("color.shadow.overlay", "rgba(15, 23, 42, 0.32)"),
];

const CODE_COMPONENTS_V1 = [
  { name: "Button", codeKey: "button", specHash: "spec-button-v1", nodeHash: "node-button-1" },
  { name: "Card", codeKey: "card", specHash: "spec-card-v1", nodeHash: "node-card-1" },
  { name: "Input", codeKey: "input", specHash: "spec-input-v1", nodeHash: "node-input-1" },
];

// Button changed in code since v1 (out of date); Card's code stayed put.
const CODE_COMPONENTS_V2 = [
  { name: "Button", codeKey: "button", specHash: "spec-button-v2", nodeHash: "node-button-1" },
  { name: "Card", codeKey: "card", specHash: "spec-card-v1", nodeHash: "node-card-1" },
  { name: "Input", codeKey: "input", specHash: "spec-input-v1", nodeHash: "node-input-1" },
];

const FIGMA_COMPONENTS = [
  { name: "Button", codeKey: "button", nodeHash: "node-button-1", figmaNodeId: "43:247" },
  { name: "Card", codeKey: "card", nodeHash: "node-card-2", figmaNodeId: "52:118" },
  { name: "Badge", codeKey: "badge", nodeHash: "node-badge-1", figmaNodeId: "61:302" },
];

function codePayload(components) {
  return {
    source: "cli",
    checkedAt: new Date().toISOString(),
    git: {
      branch: "main",
      commit: "b7a1c9f3e5d24b8a6c0f1e2d3a4b5c6d7e8f9a0b",
    },
    config: {
      figmaFileKey: FIGMA_FILE_KEY,
      figmaSource: "bridge",
      codebaseSource: "tailwind",
    },
    figmaTokens: FIGMA_TOKENS,
    codeTokens: CODE_TOKENS,
    components,
  };
}

async function main() {
  console.log(`Seeding local preview at ${BASE} …`);

  const health = await api("/api/health");
  if (!health.ok) throw new Error("worker health check failed");

  // 1. Let the worker provision the workspace (its lazy path is the source of
  //    truth), then reuse or create the demo project through the real API.
  //    The leading GET also proves the dev bypass signs us in; 401s otherwise.
  const overview = await api("/api/projects");
  let project = overview.projects.find((entry) => entry.name === PROJECT_NAME);
  if (!project) {
    const created = await api("/api/projects", {
      method: "POST",
      body: { name: PROJECT_NAME },
    });
    project = created.project;
  }
  const projectId = project.id;
  const now = new Date().toISOString();

  // 2. Reset the demo project's data so re-runs are deterministic, and clean
  //    up rows left by older fixed-id seeds (harmless if absent).
  sql(
    `DELETE FROM snapshots WHERE projectId = '${projectId}';
     DELETE FROM drift_runs WHERE projectId = '${projectId}';
     DELETE FROM deprecations WHERE projectId = '${projectId}';
     DELETE FROM figma_sources WHERE projectId = '${projectId}';
     DELETE FROM jobs WHERE projectId = '${projectId}';
     DELETE FROM snapshots WHERE projectId = 'prj_local_preview';
     DELETE FROM drift_runs WHERE projectId = 'prj_local_preview';
     DELETE FROM deprecations WHERE projectId = 'prj_local_preview';
     DELETE FROM figma_sources WHERE projectId = 'prj_local_preview';
     DELETE FROM tokens WHERE projectId = 'prj_local_preview';
     DELETE FROM connections WHERE projectId = 'prj_local_preview';
     DELETE FROM notification_rules WHERE projectId = 'prj_local_preview';
     DELETE FROM jobs WHERE projectId = 'prj_local_preview';
     DELETE FROM projects WHERE id = 'prj_local_preview';
     DELETE FROM members WHERE id = 'mbr_local_preview';
     DELETE FROM workspaces WHERE id = 'ws_local_preview';`,
  );

  // 3. Tokens for the v1 ingest endpoints (hash + last4, like the real issuance).
  const pushHash = sha256(PUSH_TOKEN);
  const pluginHash = sha256(PLUGIN_TOKEN);
  sql(
    `INSERT OR REPLACE INTO tokens (id, projectId, kind, hash, last4, label, createdAt, lastUsedAt, revokedAt)
       VALUES ('seed_token_push', '${projectId}', 'push', '${pushHash}', '${PUSH_TOKEN.slice(-4)}', 'Local preview (seed)', '${now}', NULL, NULL),
              ('seed_token_plugin', '${projectId}', 'plugin', '${pluginHash}', '${PLUGIN_TOKEN.slice(-4)}', 'Local preview (seed)', '${now}', NULL, NULL);`,
  );

  // 4. Code snapshot v1 (the "previous" push), then backdate it 5 days so
  //    specHash drift against v2 is visible as "changed since last sync".
  const v1 = await api("/api/v1/ingest/code", {
    method: "POST",
    token: PUSH_TOKEN,
    body: codePayload(CODE_COMPONENTS_V1),
  });
  sql(
    `UPDATE snapshots SET receivedAt = '${daysAgoIso(5)}' WHERE id = '${v1.snapshotId}';`,
  );

  // 5. Code snapshot v2 (current).
  await api("/api/v1/ingest/code", {
    method: "POST",
    token: PUSH_TOKEN,
    body: codePayload(CODE_COMPONENTS_V2),
  });

  // 6. Figma snapshot (plugin side): Card moved in Figma, Badge is Figma-only.
  await api("/api/v1/ingest/figma", {
    method: "POST",
    token: PLUGIN_TOKEN,
    body: {
      figma: { fileKey: FIGMA_FILE_KEY, fileName: FIGMA_FILE_NAME },
      capturedAt: new Date().toISOString(),
      tokens: FIGMA_TOKENS,
      components: FIGMA_COMPONENTS,
      pluginVersion: "1.0.0",
    },
  });

  // 7. Deprecations — one overdue, one still in code, one safe to remove.
  const deprecations = [
    {
      name: "color.brand.legacy",
      type: "token",
      reason: "Replaced by color.brand.primary",
      since: daysAgoDate(60),
      removeBy: daysAgoDate(5),
    },
    {
      name: "spacing.xl",
      type: "token",
      reason: "Collapsing into the new spacing scale",
      since: daysAgoDate(30),
      removeBy: daysAgoDate(-90),
    },
    {
      name: "color.deprecated.gone",
      type: "token",
      reason: "Gone from code and Figma — drop from this list",
      since: daysAgoDate(120),
      removeBy: null,
    },
  ];
  for (const deprecation of deprecations) {
    await api(`/api/projects/${projectId}/deprecations`, {
      method: "POST",
      body: deprecation,
    });
  }

  // 8. Drift runs: one for today with the live counts, two backdated for the
  //    trend charts (counts clone the live ones).
  const detail = await api(`/api/projects/${projectId}`);
  const driftKeys = [
    "valueMismatches",
    "missingInCode",
    "missingInFigma",
    "componentsOutOfDate",
    "componentsChangedInFigma",
    "componentsInCodeNotInFigma",
    "componentsInFigmaNotInCode",
    "deprecationOverdue",
  ];
  const total = driftKeys.reduce((sum, key) => sum + (detail.counts[key] ?? 0), 0);
  const state = total > 0 ? "drift" : "ok";
  const countsJson = JSON.stringify(detail.counts);
  sql(
    `INSERT INTO drift_runs (id, projectId, state, counts, triggeredBy, error, createdAt) VALUES
       ('seed_run_1', '${projectId}', '${state}', '${countsJson}', 'seed', NULL, '${daysAgoIso(0)}'),
       ('seed_run_2', '${projectId}', '${state}', '${countsJson}', 'seed', NULL, '${daysAgoIso(3)}'),
       ('seed_run_3', '${projectId}', '${state}', '${countsJson}', 'seed', NULL, '${daysAgoIso(6)}');`,
  );

  // 9. Verify through the API, exactly as the console reads it.
  const finalOverview = await api("/api/projects");
  const entry = finalOverview.projects.find((p) => p.id === projectId);
  const verified = await api(`/api/projects/${projectId}`);
  console.log("\nDone. Demo project state:");
  console.log(`  state:            ${entry?.state} (${total} drift items)`);
  console.log(`  value mismatches: ${verified.details?.valueMismatches.length ?? 0}`);
  console.log(`  missing (code/figma): ${verified.details?.missingInCode.length ?? 0}/${verified.details?.missingInFigma.length ?? 0}`);
  console.log(`  component issues: ${(verified.details?.componentsOutOfDate.length ?? 0) + (verified.details?.componentsChangedInFigma.length ?? 0) + (verified.details?.componentsInCodeNotInFigma.length ?? 0) + (verified.details?.componentsInFigmaNotInCode.length ?? 0)}`);
  console.log(`  deprecations overdue: ${verified.details?.deprecationOverdue.length ?? 0}`);
  console.log(`  trend points:     ${verified.trend.length}`);
  console.log(`\nOpen the console: ${BASE}/`);
}

main().catch((error) => {
  console.error(`\nSeed failed: ${error.message}`);
  console.error(
    "Is `wrangler dev` running on :8787 with DEV_ONLY_FAKE_USER set in .dev.vars?",
  );
  process.exit(1);
});
