import {startPluginProject} from './plugin-project.js';
import { discoverProject } from "./discovery.js";
import { deliverSyncNotifications } from "./sync-notifications.js";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { watch } from "chokidar";
import { fileURLToPath } from "node:url";
import { acquireBridge } from "../mcp/src/runtime.js";
import { loadRuntimeBridgeConfig } from "../mcp/src/config.js";
import { loadWatchEnv } from "../watch/src/bridge.js";
import { runElfCheck } from "../watch/src/check.js";
import { findConfigPath, loadConfig } from "./config.js";
import { createSettingsServer, DEFAULT_SETTINGS_PORT, openSettingsBrowser, reopenCompatibleSettingsServer, reopenSettingsServer } from "./settings.js";
import { completeProjectSetup, projectResource, saveProjectSetup, validateProjectSources, type OnboardingController } from "./onboarding.js";
import { createHash } from "node:crypto";
import { SyncAlerts } from "./sync-alerts.js";
import { ProjectService } from "./project.js";
import { postNotification, resolveNotifyWebhook } from "./notify.js";
import { loadSettingsEnv } from "./env.js";

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("elf start — open project setup and monitor code for drift\n\nUsage: elf start [--config <path>] [--no-open]\n\nThe current folder is the project. Monitoring does not write to Figma.");
    return 0;
  }
  let configPath = findConfigPath() ?? resolve("elf.config.json");
  let settingsPort = DEFAULT_SETTINGS_PORT;
  let noOpen = process.env.ELF_SETTINGS_NO_OPEN === "1";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--no-open") noOpen = true;
    else if (argv[i] === "--settings-port" && argv[i + 1]) {
      settingsPort = Number(argv[++i]);
      if (!Number.isInteger(settingsPort) || settingsPort < 0 || settingsPort > 65535) throw new Error("Settings port must be an integer between 0 and 65535.");
    }
    else if (argv[i] === "--config" && argv[i + 1]) configPath = resolve(argv[++i]);
    else throw new Error(`Unknown startup option: ${argv[i]}`);
  }
  const root = dirname(configPath);
  if (!existsSync(configPath)) console.log("Prefer working in VS Code? Run elf extension for the native editor preview. npm remains supported.");
  if (!existsSync(fileURLToPath(new URL("../dist/settings/index.html", import.meta.url)))) {
    throw new Error("Settings assets are missing. Build settings-next before packaging Elf.");
  }
  loadWatchEnv(root);
  loadSettingsEnv(configPath);
  const bridgeConfig = loadRuntimeBridgeConfig();
  const runtime = await acquireBridge(bridgeConfig, { log: line => console.error(`elf: ${line}`) });
  if (runtime.connection.status.port !== null) process.env.ELF_MCP_PORT = String(runtime.connection.status.port);
  if (runtime.pairingCode) console.log(`Pairing code: ${runtime.pairingCode.code}\nPaste this into the Elf bridge plugin in Figma. The code expires in five minutes; saved pairing survives restarts.`);
  else console.log("Using the existing Elf bridge. Open the paired plugin in your Figma file.");

  const project = new ProjectService(configPath, runtime);
  const stopPluginProject=await startPluginProject(project,runtime);
  const alerts = new SyncAlerts(configPath);
  let watcher: ReturnType<typeof watch> | null = null;
  let running = false;
  let starting: Promise<void> | null = null;
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let polling: NodeJS.Timeout | undefined;
  let checking: Promise<void> | null = null;
  let rerun = false;
  let lastCheck: Record<string, unknown> | null = null;
  let lastError: string | null = null;
  let handle: Awaited<ReturnType<typeof createSettingsServer>> | null = null;
  const configured = (): boolean => {
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf8"));
      return raw.runtime?.projectConfigured === true || raw.runtime?.setupComplete === true;
    } catch { return false; }
  };
  const completed = (): boolean => {
    try { return JSON.parse(readFileSync(configPath, "utf8")).runtime?.setupComplete === true; }
    catch { return false; }
  };
  const check = (): void => {
    if (stopping) return;
    if (checking) { rerun = true; return; }
    checking = (async () => {
      do {
        rerun = false;
        const config = loadConfig(configPath);
        const file = runtime.connection.status.file;
        if (runtime.connection.status.pendingApproval) {
          lastError = 'Approve the open Figma document in Elf before checking or syncing.';
          return;
        }
        if (!runtime.connection.isConnected || !file?.key) {
          lastError = "Open the Elf bridge plugin in Figma. Your next check will run when it reconnects.";
          console.log(lastError);
          return;
        }
        if (file.key !== config.figma.fileKey) {
          lastError = "The connected Figma file does not match this project. Open the configured file to continue.";
          console.error(lastError);
          return;
        }
        const notify = Boolean(config.notify && resolveNotifyWebhook(config.notify, configPath));
        if (project.automatic()) {
          try {
            const sync = await project.autoSync();
            if (sync.paused && notify) {
              const alert = createHash("sha256").update(JSON.stringify(sync.conflicts)).digest("hex");
              await alerts.update(alert, () => postNotification(resolveNotifyWebhook(config.notify, configPath)!.url, config.notify!.format, { text: "Elf is watching for changes. Some resources and their dependents need review and were skipped; safe independent changes continue syncing. Open Elf to review pending items." }));
            } else if (!sync.paused) await alerts.update(null);
          } catch (error) {
            project.record("error", (error as Error).message);
            if (notify) {
              const failure = createHash("sha256").update("failed:" + (error as Error).message).digest("hex");
              await alerts.update(failure, () => postNotification(resolveNotifyWebhook(config.notify, configPath)!.url, config.notify!.format, { text: "Elf could not finish automatic sync. Open Elf Settings for the error and retry after resolving it." }));
            }
          }
        }
        let syncNotificationError: string | null = null;
        try { await deliverSyncNotifications(configPath); } catch { syncNotificationError = "Sync notification could not be delivered. Check Slack settings; delivery will be retried."; project.record("error", syncNotificationError); }
        const result = await runElfCheck(configPath, root, notify);
        project.record(result.status === "failed" ? "error" : "check", result.status === "clean" ? "No drift found." : result.status === "drift" ? `${result.total ?? "Some"} drift items remain. See drift-report.md.` : result.message ?? "Drift check failed.");
        lastCheck = { ...result, checkedAt: new Date().toISOString() };
        lastError = result.status === "failed" ? result.message ?? "Drift check failed." : result.notificationError ?? syncNotificationError;
        if (result.notificationError) project.record("error", result.notificationError);
        console.log(result.status === "clean" ? "Drift: none." : result.status === "drift" ? `Drift: ${result.total ?? "some"} items. See drift-report.md.` : `Check failed: ${lastError}`);
      } while (rerun && !stopping);
    })().catch(error => { lastError = (error as Error).message; console.error(`elf: ${lastError}`); }).finally(() => { checking = null; });
  };
  const discoveredStatus = (): Record<string, unknown> => {
    const sources = discoverProject(root);
    return {sources: sources.tokens.map(path => relative(realpathSync(root), path)), discoveredComponents: sources.components.length};
  };
  const controller: OnboardingController = {
    status: () => ({
      active: !running,
      configured: configured(),
      root,
      ...discoveredStatus(),
      bridge: runtime.connection.status,
      running,
      mode: project.automatic() ? "automatic" : "monitor",
      authorization: (() => {try {return loadConfig(configPath).figma.authorization ?? 'strict';} catch {return 'strict';}})(),
      activity: project.activity,
      checking: Boolean(checking),
      attention: (() => { const latest = project.activity.find(item => item.type !== "check" && item.type !== "description"); return latest && (latest.type === "conflict" || latest.type === "error") ? latest.message : null; })(),
      integration: { command: process.execPath, args: [fileURLToPath(new URL("../bin/elf-tokens.js", import.meta.url)), "mcp", "--project", root] },
      lastCheck: (() => {
        try {
          const report = JSON.parse(readFileSync(resolve(root, "drift-status.json"), "utf8"));
          if (!report.checkedAt || (lastCheck && String(lastCheck.checkedAt) >= report.checkedAt)) return lastCheck;
          const keys = ["valueMismatches", "missingInCode", "missingInFigma", "componentsOutOfDate", "componentsChangedInFigma", "componentsInCodeNotInFigma", "componentsInFigmaNotInCode", "deprecationOverdue"];
          return { status: report.driftFound ? "drift" : "clean", total: keys.reduce((total, key) => total + (Number(report[key]) || 0), 0), checkedAt: report.checkedAt };
        } catch { return lastCheck; }
      })(),
      error: lastError,
      pluginManifest: fileURLToPath(new URL("../bridge-plugin/manifest.json", import.meta.url)),
      project: (() => { try { const config = loadConfig(configPath); return { tokenPath: relative(root, resolve(root, config.codebase.path)), source: config.codebase.source, componentsPath: config.components ? relative(root, config.components.path) : "" }; } catch { return null; } })(),
    }),
    projectAction: async (action, input) => {
      const body = input as Record<string, unknown>;
      if (action === "pairing-code") {
        const pairing = await runtime.refreshPairingCode();
        console.log(`New pairing code: ${pairing.code}\nPaste it into the Figma plugin within five minutes.`);
        return { ok: true, pairing };
      }
      if (action === "disconnect-figma") {
        await runtime.revoke(loadConfig(configPath).figma.fileKey); project.setMonitoring(); return { ok: true };
      }
      if (action === "resources") return project.resources();
      if (action === "show-plugin") {
        const key = loadConfig(configPath).figma.fileKey;
        return runtime.transaction(key, client => client.call("show_ui"));
      }
      if (action === "plan") {
        if (body.selection !== undefined && (!body.selection || typeof body.selection !== 'object' || !['token','component','style'].includes((body.selection as any).kind) || typeof (body.selection as any).key !== 'string')) throw new Error('Invalid resource selection.');
        return project.plan(body.selection as any);
      }
      if (action === 'component-library-setup' && typeof body.library === 'string') return project.componentLibrarySetup(body.library);
      if (action === 'remember-component-library' && typeof body.library === 'string') return project.rememberComponentLibrary(body.library);
      if (action === 'component-imports') return project.listComponentImports();
      if (action === 'prepare-component-import') return project.prepareComponentImport(body as any);
      if (action === 'validate-component-import') {if(typeof body.id!=='string')throw new Error('Prepare a component import.');return project.validateComponentImport(body.id,body.code);}
      if (action === 'apply-component-import') {
        if (typeof body.id!=='string') throw new Error('Review a component draft first.');
        return project.applyComponentImport(body.id,body.code);
      }
      if (action === 'plan-token-import') {
        if (body.path !== undefined && typeof body.path !== 'string' || body.ids !== undefined && (!Array.isArray(body.ids) || body.ids.some(id => typeof id !== 'string'))) throw new Error('Invalid import selection.');
        return project.planTokenImport(body.path as string | undefined,body.ids as string[] | undefined);
      }
      if (action === 'apply-token-import') {
        if (typeof body.planId !== 'string') throw new Error('Review a token import first.');
        return project.applyTokenImport(body.planId);
      }
      if (action === "components") return project.listComponents();
      if (action === 'pending-document') return project.pendingDocument();
      if (action === 'approve-document' && typeof body.fileKey === 'string' && typeof body.ticket === 'string') return project.approveDocument(body.fileKey, body.ticket, body.optIn === true);
      if (action === 'strict-authorization') return project.useStrictAuthorization();
      if (action === "validate-description" && typeof body.component === "string" && typeof body.reviewHash === "string") return project.validateDescription(body.component, body.description, body.reviewHash);
      if (action === "apply") {
        if (typeof body.planId !== "string" || (body.enableAuto !== undefined && typeof body.enableAuto !== "boolean") || (body.overwriteConflicts !== undefined && typeof body.overwriteConflicts !== "boolean")) throw new Error("Invalid sync request.");
        const result = await project.apply(body.planId, { enableAuto: body.enableAuto === true, overwriteConflicts: body.overwriteConflicts === true });
        check(); return result;
      }
      if (action === "monitor") { project.setMonitoring(); return { ok: true }; }
      if (action === "check") { check(); return { ok: true }; }
      if(action==='prepare-documentation'&&typeof body.component==='string')return project.prepareDocumentation(body.component);
      if(action==='save-documentation'&&typeof body.id==='string'&&typeof body.text==='string')return project.saveDocumentation(body.id,body.text);
      if(action==='sync-documentation'&&typeof body.id==='string'&&typeof body.text==='string')return project.syncDocumentation(body.id,body.text);
      if (action === "prepare-component" && typeof body.component === "string") return project.prepareComponent(body.component);
      if (action === "save-description" && typeof body.component === "string") {
        if (typeof body.reviewHash !== "string" || !/^[a-f0-9]{64}$/.test(body.reviewHash)) throw new Error("Prepare and review the component description before saving.");
        return project.saveDescription(body.component, body.description, body.reviewHash);
      }
      if (action === "test-slack") {
        const webhook = resolveNotifyWebhook({ webhookEnv: "SLACK_WEBHOOK_URL", format: "slack" }, configPath);
        if (!webhook) throw new Error("Connect Slack before sending a test message.");
        await postNotification(webhook.url, "slack", { text: "Elf is connected. Drift alerts for this project will appear here." });
        return { ok: true };
      }
      throw new Error("Unknown project action.");
    },
    validate: input => { validateProjectSources(configPath, input); },
    requestPairingCode: async () => {
      const pairing = await runtime.refreshPairingCode();
      console.log(`New pairing code: ${pairing.code}\nPaste it into the Figma plugin within five minutes. Existing saved sessions remain valid.`);
    },
    save: input => { if (running) throw new Error("Stop watching before changing project setup."); saveProjectSetup(configPath, input, runtime.connection.status); },
    start: () => {
      if (running) return Promise.resolve();
      if (starting) return starting;
      starting = (async () => {
        if (!configured()) throw new Error("Finish project setup first.");
        const config = loadConfig(configPath);
        if (!runtime.connection.status.connected || runtime.connection.status.file?.key !== config.figma.fileKey) throw new Error("Open the configured Figma file and connect its Elf plugin first.");
        const paths = project.watchPaths();
        const generated = new Set(project.generatedPaths());
        watcher = watch([...paths, configPath], { ignoreInitial: true, followSymlinks: false, ignored: /(^|[/\\])(node_modules|\.git|dist|build|\.next|\.elf)([/\\]|$)|\.tmp$/, awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 } });
        watcher.on("all", (_event, path) => {
          if (generated.has(resolve(path)) && resolve(path) !== resolve(configPath)) return;
          if (resolve(path) === resolve(configPath)) {
            try { watcher?.add(project.watchPaths()); }
            catch (error) { lastError = (error as Error).message; }
          }
          if (timer) clearTimeout(timer);
          timer = setTimeout(check, 1000);
        });
        watcher.on("error", error => { lastError = (error as Error).message; console.error(`elf: ${lastError}`); });
        try {
          await new Promise<void>((resolveReady, rejectReady) => {
            watcher!.once("ready", resolveReady);
            watcher!.once("error", rejectReady);
          });
          if (stopping) return;
          completeProjectSetup(configPath);
        } catch (error) {
          await watcher?.close();
          watcher = null;
          throw error;
        }
        running = true;
        polling = setInterval(check, 60_000);
        polling.unref();
        console.log(`Watching ${root}. Mode: ${project.automatic() ? "automatic sync" : "monitoring"}.`);
        check();
      })().finally(() => { starting = null; });
      return starting;
    },
  };
  const offStatus = runtime.connection.onStatus(status => {
    if (!status.connected || !status.file?.key || stopping) return;
    if (running) check();
    else if (configured() && completed()) {
      void controller.start().catch(error => { lastError = (error as Error).message; console.error(`elf: ${lastError}`); });
    }
  });
  let finish: () => void = () => {};
  const done = new Promise<void>(resolve => { finish = resolve; });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true; stopping = true;
    await stopPluginProject();
    if (timer) clearTimeout(timer);
    if (polling) clearInterval(polling);
    await watcher?.close();
    await checking;
    offStatus();
    await handle?.close();
    await runtime.close();
    finish();
  };
  const onSignal = (): void => { void close(); };
  // The editor owns this private IPC channel. Never accept these requests over HTTP.
  const onEditorMessage = (message: unknown): void => {
    if (!message || typeof message !== "object") return;
    const input = message as Record<string, unknown>;
    if (input.type !== "elf:open-settings" || !Number.isSafeInteger(input.id) || !handle || stopping) return;
    void reopenSettingsServer(handle.url, configPath, bridgeConfig.token).then(url => {
      if (process.connected) process.send?.({ type: "elf:settings", id: input.id, url });
    }).catch(() => { if (process.connected) process.send?.({ type: "elf:settings", id: input.id, url: null }); });
  };
  if (process.send) process.on("message", onEditorMessage);
  process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
  try {
    try { handle = await createSettingsServer(configPath, { port: settingsPort, onboarding: controller, identityToken: bridgeConfig.token }); }
    catch (error) {
      const url = `http://127.0.0.1:${settingsPort}`;
      const reopen = (error as NodeJS.ErrnoException).code === "EADDRINUSE" ? await reopenCompatibleSettingsServer(url, configPath, bridgeConfig.token, true) : null;
      if (reopen) {
        console.log(`Elf is already running for this project. Settings: ${reopen}`);
        if (!noOpen) openSettingsBrowser(reopen);
        return 0;
      }
      throw error;
    }
    if (stopping) { await handle.close(); return 0; }
    console.log(`Settings: ${handle.publicUrl}\nProject: ${root}\nKeep this terminal open. Press Ctrl+C to stop.`);
    if (configured() && completed()) {
      try { await controller.start(); } catch (error) { lastError = (error as Error).message; console.error(`elf: ${lastError}`); }
    }
    if (!noOpen) openSettingsBrowser(handle.publicUrl);
    await done;
    return 0;
  } finally {
    process.off("message", onEditorMessage);
    process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal);
    await close();
  }
}
