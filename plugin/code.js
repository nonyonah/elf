"use strict";
const CONFIG_KEY = "elf-tokens-config";
function loadConfig() {
    try {
        const raw = figma.root.getPluginData(CONFIG_KEY);
        return raw ? JSON.parse(raw) : {};
    }
    catch {
        return {};
    }
}
function saveConfig(config) {
    figma.root.setPluginData(CONFIG_KEY, JSON.stringify(config));
}
async function runCheck() {
    const config = loadConfig();
    if (!config.workerUrl || !config.passcode) {
        figma.ui.postMessage({ type: "result", ok: false, error: "Save the worker URL and passcode first." });
        return;
    }
    try {
        const fileKey = figma.fileKey ?? "";
        const url = `${config.workerUrl}?fileKey=${encodeURIComponent(fileKey)}&passcode=${encodeURIComponent(config.passcode)}`;
        const response = await fetch(url);
        const data = (await response.json());
        figma.ui.postMessage({ type: "result", ok: response.ok && data?.ok !== false, data });
    }
    catch (error) {
        figma.ui.postMessage({ type: "result", ok: false, error: String(error) });
    }
}
figma.showUI(__html__, { width: 360, height: 520, themeColors: true });
figma.ui.onmessage = (message) => {
    switch (message.type) {
        case "context":
            figma.ui.postMessage({
                type: "context",
                file: { fileName: figma.root.name, fileKey: figma.fileKey ?? "unknown" },
                config: loadConfig(),
            });
            break;
        case "save-config":
            saveConfig({ workerUrl: message.workerUrl ?? "", passcode: message.passcode ?? "" });
            break;
        case "check":
            void runCheck();
            break;
    }
};
