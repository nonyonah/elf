const vscode = require('vscode');
const { Runtime } = require('./runtime.cjs');
const { NativeElf } = require('./native.cjs');
let runtime;
let native;

function activate(context) {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'elf.settings';
  const setContext = (key, value) => {
    if (vscode.commands.executeCommand) void vscode.commands.executeCommand('setContext', key, value);
  };
  const update = () => {
    const state = runtime?.state ?? 'stopped';
    status.text = `$(elf-mascot) ${state === 'running' ? 'Elf' : state === 'starting' ? 'Elf: Starting' : state === 'failed' ? 'Elf: Error' : 'Elf: Stopped'}`;
    status.tooltip = state === 'running' ? 'Open Elf' : state === 'starting' ? 'Elf is starting' : 'Open Elf to start monitoring';
    status.show();
    setContext('elf.running', state === 'running');
    native?.invalidate();
    if (state === 'running') void native?.refresh();
  };
  update();
  const register = (name, action) => context.subscriptions.push(vscode.commands.registerCommand(name, async () => {
    try { await action(); } catch (error) { void vscode.window.showErrorMessage(error.message); }
  }));
  async function start() {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before starting Elf.');
    if (runtime?.child) return runtime;
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
    if (!folders.length) throw new Error('Open a local project folder first.');
    const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Select the project Elf should monitor' });
    if (!folder || folder.uri.scheme !== 'file') return;
    runtime = new Runtime(folder.uri.fsPath, update);
    runtime.start();
    return runtime;
  }
  async function ensureRuntime() {
    const current = runtime?.child ? runtime : await start();
    if (!current) return;
    const deadline = Date.now() + 20_000;
    while (runtime === current && current.state === 'starting' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    if (runtime !== current || current.state !== 'running') throw new Error('Elf is not ready. Retry Start or Refresh.');
    return current;
  }
  native = new NativeElf(vscode, context, () => runtime, ensureRuntime);
  context.subscriptions.push(native);
  register('elf.start', async () => { if (await start()) await native?.show(); });
  register('elf.stop', async () => { await runtime?.stop(); native?.invalidate(); });
  register('elf.settings', async () => { await native?.show(); });
  context.subscriptions.push(status, vscode.workspace.onDidChangeWorkspaceFolders(() => {
    void (async () => { await runtime?.stop(); native?.invalidate(); })();
  }));
}
async function deactivate() {
  native?.dispose();
  native = null;
  await runtime?.stop();
  runtime = null;
}
module.exports = { activate, deactivate };
