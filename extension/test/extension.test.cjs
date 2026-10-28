const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

function harness(trusted = true) {
  const commands = new Map(); const errors = []; const runtimes = []; const natives = []; const executed = []; const statuses = [];
  const vscode = {
    StatusBarAlignment: { Right: 1 },
    window: {
      createStatusBarItem: () => { const status = { show() {}, dispose() {} }; statuses.push(status); return status; },
      showErrorMessage: async message => { errors.push(message); },
      showWorkspaceFolderPick: async () => null,
    },
    workspace: {
      isTrusted: trusted,
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: '/project' } }],
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    },
    commands: {
      registerCommand: (name, callback) => { commands.set(name, callback); return { dispose() {} }; },
      executeCommand: async (name, ...args) => { executed.push({ name, args }); },
    },
  };
  class FakeRuntime {
    constructor(root, changed) { this.root = root; this.changed = changed; this.state = 'stopped'; runtimes.push(this); }
    start() { this.child = {}; this.state = 'running'; this.changed(); }
    async stop() { this.child = null; this.state = 'stopped'; this.changed(); }
  }
  class FakeNative {
    constructor(vscodeApi, context, getRuntime, ensureRuntime) { this.ensureRuntime = ensureRuntime; natives.push(this); }
    async show() { const runtime = await this.ensureRuntime(); if (runtime) await vscode.commands.executeCommand('workbench.view.extension.elf'); }
    invalidate() {}
    refresh() {}
    dispose() {}
  }
  const module = { exports: {} };
  const source = readFileSync(join(__dirname, '../src/extension.cjs'), 'utf8');
  new Function('require', 'module', source)(name => name === 'vscode' ? vscode : name === './runtime.cjs' ? { Runtime: FakeRuntime } : { NativeElf: FakeNative }, module);
  module.exports.activate({ subscriptions: [] });
  return { vscode, commands, errors, runtimes, natives, executed, statuses, deactivate: module.exports.deactivate };
}

test('untrusted workspace commands cannot start a runtime or open the native view', async () => {
  const h = harness(false);
  await h.commands.get('elf.start')(); await h.commands.get('elf.settings')();
  assert.equal(h.runtimes.length, 0);
  assert.equal(h.executed.some(item => item.name === 'workbench.view.extension.elf'), false);
  assert.equal(h.errors.length, 2);
  assert.match(h.errors[0], /Trust this workspace/);
});

test('native Open starts one owned runtime; Stop and deactivation release it', async () => {
  const h = harness();
  await h.commands.get('elf.settings')(); await h.commands.get('elf.start')();
  assert.equal(h.runtimes.length, 1); assert.equal(h.runtimes[0].root, '/project');
  assert.equal(h.natives.length, 1);
  assert(h.executed.some(item => item.name === 'workbench.view.extension.elf'));
  await h.commands.get('elf.stop')(); assert.equal(h.runtimes[0].child, null);
  await h.commands.get('elf.start')(); assert.equal(h.runtimes.length, 2);
  await h.deactivate(); assert.equal(h.runtimes[1].child, null);
});

test('empty and virtual workspaces cannot launch local code', async () => {
  const h = harness(); h.vscode.workspace.workspaceFolders = [{ uri: { scheme: 'vscode-vfs' } }];
  await h.commands.get('elf.start')();
  assert.equal(h.runtimes.length, 0);
  assert.match(h.errors[0], /local project folder/);
});

test('native status bar uses the registered mascot glyph in stopped and running states',async()=>{
 const h=harness();
 assert.match(h.statuses[0].text,/^\$\(elf-mascot\)/);
 const pkg=JSON.parse(readFileSync(join(__dirname,'../package.json'),'utf8'));
 const icon=pkg.contributes.icons['elf-mascot'];
 assert.equal(icon.default.fontCharacter,'\\E001');
 const font=readFileSync(join(__dirname,'..',icon.default.fontPath));
 assert.equal(font.subarray(0,4).toString(),'wOFF');
 await h.commands.get('elf.start')();
 assert.equal(h.statuses[0].text,'$(elf-mascot) Elf');
 await h.deactivate();
});
