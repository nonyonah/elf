interface SavedConfig {
  workerUrl?: string;
  passcode?: string;
}

interface ContextMessage {
  type: "context";
  file: { fileName: string; fileKey: string };
  config: SavedConfig;
}

interface ResultMessage {
  type: "result";
  ok: boolean;
  error?: string;
  data?: {
    ok?: boolean;
    repo?: string;
    checkedAt?: string | null;
    driftFound?: boolean;
    counts?: { valueMismatches: number; missingInCode: number; missingInFigma: number };
    report?: string | null;
  };
}

const CONFIG_KEY = "elf-tokens-config";

function loadConfig(): SavedConfig {
  try {
    const raw = figma.root.getPluginData(CONFIG_KEY);
    return raw ? (JSON.parse(raw) as SavedConfig) : {};
  } catch {
    return {};
  }
}

function saveConfig(config: SavedConfig): void {
  figma.root.setPluginData(CONFIG_KEY, JSON.stringify(config));
}

async function runCheck(): Promise<void> {
  const config = loadConfig();
  if (!config.workerUrl || !config.passcode) {
    figma.ui.postMessage({ type: "result", ok: false, error: "Save the worker URL and passcode first." });
    return;
  }
  try {
    const fileKey = figma.fileKey ?? "";
    const url = `${config.workerUrl}?fileKey=${encodeURIComponent(fileKey)}&passcode=${encodeURIComponent(config.passcode)}`;
    const response = await fetch(url);
    const data = (await response.json()) as ResultMessage["data"];
    figma.ui.postMessage({ type: "result", ok: response.ok && data?.ok !== false, data });
  } catch (error) {
    figma.ui.postMessage({ type: "result", ok: false, error: String(error) });
  }
}

figma.showUI(__html__, { width: 360, height: 520, themeColors: true });

figma.ui.onmessage = (message: { type: string; workerUrl?: string; passcode?: string }) => {
  switch (message.type) {
    case "context":
      figma.ui.postMessage({
        type: "context",
        file: { fileName: figma.root.name, fileKey: figma.fileKey ?? "unknown" },
        config: loadConfig(),
      } satisfies ContextMessage);
      break;
    case "save-config":
      saveConfig({ workerUrl: message.workerUrl ?? "", passcode: message.passcode ?? "" });
      break;
    case "check":
      void runCheck();
      break;
  }
};