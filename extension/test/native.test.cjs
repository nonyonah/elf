const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { NativeElf } = require('../src/native.cjs');

function uri(fsPath) {
  return { scheme: 'file', fsPath, path: fsPath, toString: () => `file://${fsPath}` };
}

function harness(options = {}) {
  const commands = new Map(); const errors = []; const opened = []; const clipboard = []; const executed = [];
  const quickPicks = []; const infoResponses = []; const warningResponses = []; const inputResponses = [];
  const infoMessages = []; const warningMessages = [];
  const documents = []; const views = []; const files = new Map(); const providers = new Map();
  const workspaceState = new Map();
  const project = {
    active: true, configured: options.configured !== false, root: '/project',
    sources: ['src/tokens.css'], discoveredComponents: 2,
    bridge: options.bridgeConnected === false ? { connected: false, file: null } : { connected: true, file: { key: 'file', name: 'Design' } },
    running: options.running !== false, mode: options.mode || 'monitor',
    activity: options.activity || [{ id: 'a1', at: '2026-10-27T00:00:00.000Z', type: 'check', message: 'Drift found' }],
    checking: false, attention: null, error: null,
    integration: { command: 'node', args: ['/elf/bin/elf-tokens.js', 'mcp', '--project', '/project'] },
    lastCheck: options.lastCheck === undefined ? { status: 'drift', total: 2, checkedAt: '2026-10-27T00:00:00.000Z' } : options.lastCheck,
    project: { tokenPath: 'src/tokens.css', source: 'css', componentsPath: 'src/components' },
  };
  const notify = options.notify === undefined ? { enabled: true, onlyOnChange: true } : options.notify;
  const slack = options.slack || { connected: false };
  const requests = [];
  const runtime = {
    state: options.runtimeState || 'running', root: '/project', pairing: options.pairing || null,
    request: async (path, method = 'GET', body) => {
      requests.push({ path, method, body });
      let data;
      if (path === '/api/config' && method === 'GET') data = { project: { configPath: '/project/elf.config.json', fileKey: 'file' }, onboarding: project, notify, slack };
      else if (path === '/api/config' && method === 'PATCH') data = { ok: true };
      else if (path === '/api/figma/account') data = { connected: options.figmaConnected !== false };
      else if (path === '/api/onboarding') data = project;
      else if (path === '/api/onboarding/validate' || path === '/api/onboarding/start') data = { ok: true };
      else if (path === '/api/project/plan') data = options.plan || { id: 'plan-1', entries: [{ kind: 'token', key: 'color.brand', name: 'color.brand', action: 'update' }], issues: [], expiresAt: '2026-10-27T00:10:00.000Z' };
      else if (path === '/api/project/apply') data = options.applyResult || { synced: 1, issues: [] };
      else if (path === '/api/project/resources') data = { resources: options.resources || [{ name: 'color.brand', verified: true, recorded: true, figmaUrl: 'https://www.figma.com/design/file' }] };
      else if (path === '/api/project/check' || path === '/api/project/monitor' || path === '/api/slack/test' || path === '/api/figma/disconnect' || path === '/api/slack/disconnect' || path === '/api/project/disconnect-figma' || path === '/api/project/save-description') data = { ok: true };
      else if (path === '/api/project/pairing-code') { data = { ok: true }; if (options.newPairing) runtime.pairing = { code: 'NEW-CODE', expires: Date.now() + 60_000 }; }
      else if (path === '/api/figma/connect') data = { url: options.connectUrl || 'https://www.figma.com/oauth?state=private', authorizationOrigin: options.connectOrigin || 'https://www.figma.com' };
      else if (path === '/api/slack/connect') data = { url: options.connectUrl || 'https://slack.com/oauth?state=private', authorizationOrigin: options.connectOrigin || 'https://slack.com' };
      else if (path === '/api/report') data = { markdown: '# Drift' };
      else if (path === '/api/project/prepare-component') data = options.prepared || {
        name: 'Button', codeKey: 'button.tsx#Button', path: 'components/Button.figma.json',
        reviewHash: 'a'.repeat(64), sidecar: { layoutMode: 'HORIZONTAL' }, warning: null,
      };
      else return { status: 404, body: JSON.stringify({ error: 'Not found' }) };
      return { status: 200, body: JSON.stringify(data) };
    },
  };
  class EventEmitter {
    constructor() { this.listeners = []; this.event = listener => { this.listeners.push(listener); return { dispose: () => { this.listeners = this.listeners.filter(item => item !== listener); } }; }; }
    fire(value) { for (const listener of [...this.listeners]) listener(value); }
    dispose() { this.listeners = []; }
  }
  class TreeItem { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } }
  class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
  class ThemeColor { constructor(id) { this.id = id; } }
  const Uri = {
    file: uri,
    joinPath: (base, ...parts) => uri(join(base.fsPath, ...parts)),
    parse: value => ({ href: value, fsPath: value, path: value, scheme: new URL(value).protocol.slice(0, -1), toString: () => value }),
  };
  const vscode = {
    EventEmitter, TreeItem, ThemeIcon, ThemeColor,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    StatusBarAlignment: { Right: 1 },
    Uri,
    window: {
      visibleTextEditors: [],
      createTreeView: (id, opts) => { const view = { id, visible: true, provider: opts.treeDataProvider, dispose() {}, onDidExpandElement: () => ({ dispose() {} }) }; views.push(view); return view; },
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      showErrorMessage: async message => { errors.push(message); },
      showInformationMessage: async (message, ...actions) => { infoMessages.push({ message, actions }); return infoResponses.shift(); },
      showWarningMessage: async (message, ...actions) => { warningMessages.push({ message, actions }); return warningResponses.shift(); },
      showQuickPick: async () => quickPicks.shift(),
      showInputBox: async () => inputResponses.shift(),
      showTextDocument: async document => { documents.push(document); vscode.window.activeTextEditor = { document }; return { document }; },
      onDidChangeWindowState: () => ({ dispose() {} }),
    },
    workspace: {
      isTrusted: options.trusted !== false,
      workspaceFolders: [{ uri: uri('/project') }],
      fs: {
        stat: async target => { if (!files.has(target.fsPath)) throw new Error('missing'); return { size: files.get(target.fsPath).length }; },
        readFile: async target => { if (!files.has(target.fsPath)) throw new Error('missing'); return files.get(target.fsPath); },
        writeFile: async (target, content) => { files.set(target.fsPath, Buffer.from(content)); },
        createDirectory: async () => {},
        delete: async target => { files.delete(target.fsPath); },
      },
      registerTextDocumentContentProvider: (scheme, provider) => { providers.set(scheme, provider); return { dispose() {} }; },
      openTextDocument: async input => { const readonly = input.scheme === 'elf-readonly'; const language = readonly ? input.toString().includes('.md?') ? 'markdown' : 'json' : input.language; const content = readonly ? providers.get(input.scheme).provideTextDocumentContent(input) : input.content; const document = { languageId: language, isUntitled: !readonly, getText: () => content, uri: readonly ? input : uri(`/untitled/${documents.length}.${language}`) }; documents.push(document); return document; },
      onDidCloseTextDocument: () => ({ dispose() {} }),
    },
    commands: {
      registerCommand: (name, callback) => { commands.set(name, callback); return { dispose() {} }; },
      executeCommand: async (name, ...args) => { executed.push({ name, args }); },
    },
    env: { openExternal: async target => { opened.push(target); }, clipboard: { writeText: async value => { clipboard.push(value); } } },
  };
  const context = {
    subscriptions: [], storageUri: uri('/storage'), workspaceState: {
      get: (key, fallback) => workspaceState.has(key) ? workspaceState.get(key) : fallback,
      update: async (key, value) => { workspaceState.set(key, value); },
    },
  };
  const native = new NativeElf(vscode, context, () => runtime, async () => runtime);
  return { vscode, context, native, runtime, project, requests, commands, errors, opened, clipboard, executed, quickPicks, infoResponses, warningResponses, infoMessages, warningMessages, inputResponses, documents, views, files };
}

test('native views separate daily status, changes, and activity from management', async t => {
  const h = harness(); t.after(() => h.native.dispose());
  await h.native.refresh();
  assert.deepEqual(h.views.map(view => view.id), ['elf.overview', 'elf.changes', 'elf.activityView']);
  const overview = await h.native.getChildren();
  assert.deepEqual(overview.map(item => item.label), ['project', 'Figma file', '2 differences', 'Drift details']);
  assert.equal(overview[0].description, 'Monitoring');
  const changes = await h.native.getChildren(undefined, 'changes');
  assert(changes.some(item => item.label === 'Review code changes'));
  assert.equal(changes.some(item => item.label === 'Figma account' || item.label === 'Automatic sync'), false);
  const resources = await h.native.getChildren(changes.find(item => item.label === 'Synced resources'));
  assert.equal(resources[0].label, 'color.brand');
  const activity = await h.native.getChildren(undefined, 'activity');
  assert(activity.some(item => item.label === 'Drift found'));
});

test('review sync stays in the native tree and applies only the reviewed plan', async t => {
  const h = harness(); t.after(() => h.native.dispose());
  await h.native.refresh();
  await h.commands.get('elf.reviewSync')();
  const roots = await h.native.getChildren();
  const sync = await h.native.getChildren(undefined, 'changes');
  const planned = sync.find(item => item.label === '1 planned change');
  assert(planned);
  assert.equal((await h.native.getChildren(planned))[0].label, 'color.brand');
  assert(sync.some(item => item.label === 'Apply sync'));
  await h.commands.get('elf.applySync')();
  const apply = h.requests.find(request => request.path === '/api/project/apply');
  assert.deepEqual(JSON.parse(apply.body), { planId: 'plan-1', enableAuto: false, overwriteConflicts: false });
  assert.equal(h.native.plan, null);
});

test('conflicts require explicit replacement before applying', async t => {
  const h = harness({ plan: { id: 'plan-2', entries: [{ kind: 'component', key: 'button', name: 'Button', action: 'update' }], issues: [{ kind: 'conflict', key: 'button', message: 'Figma changed', blocksApply: true }], expiresAt: '2026-10-27T00:10:00.000Z' } });
  t.after(() => h.native.dispose());
  await h.native.refresh();
  await h.commands.get('elf.reviewSync')();
  await h.commands.get('elf.applySync')();
  assert.match(h.errors.at(-1), /Replace Figma edits/);
  assert.equal(h.requests.some(request => request.path === '/api/project/apply'), false);
  await h.commands.get('elf.toggleReplace')();
  h.warningResponses.push('Replace and apply');
  await h.commands.get('elf.applySync')();
  const apply = h.requests.find(request => request.path === '/api/project/apply');
  assert.equal(JSON.parse(apply.body).overwriteConflicts, true);
});

test('preferences use the nested notify API shape', async t => {
  const h = harness(); t.after(() => h.native.dispose());
  h.quickPicks.push([{ key: 'notify' }, { key: 'onlyOnChange' }]);
  await h.commands.get('elf.preferences')();
  const patch = h.requests.find(request => request.path === '/api/config' && request.method === 'PATCH');
  assert.deepEqual(JSON.parse(patch.body), { notify: { enabled: true, onlyOnChange: true } });
  await h.commands.get('elf.toggleNotify')();
  const off = h.requests.filter(request => request.path === '/api/config' && request.method === 'PATCH').at(-1);
  assert.deepEqual(JSON.parse(off.body), { notify: { enabled: false } });
});

test('connections open only the server-issued authorization origin', async t => {
  const h = harness({ figmaConnected: false }); t.after(() => h.native.dispose());
  await h.commands.get('elf.figma')();
  assert.equal(h.opened.length, 1);
  assert.equal(h.opened[0].href, 'https://www.figma.com/oauth?state=private');
  const bad = harness({ figmaConnected: false, connectUrl: 'https://evil.test/oauth', connectOrigin: 'https://console.test' });
  t.after(() => bad.native.dispose());
  await bad.commands.get('elf.figma')();
  assert.equal(bad.opened.length, 0);
  assert.match(bad.errors.at(-1), /Unexpected authorization address/);
});

test('pairing, report, resources, and assistants use native affordances', async t => {
  const h = harness({ pairing: { code: 'ABCD-1234', expires: Date.now() + 60_000 } });
  t.after(() => h.native.dispose());
  await h.native.refresh();
  h.infoResponses.push('Copy code');
  await h.commands.get('elf.pairing')();
  assert.deepEqual(h.clipboard, ['ABCD-1234']);
  h.files.set('/project/drift-report.md', Buffer.from('# Drift'));
  await h.commands.get('elf.report')();
  assert.equal(h.executed.some(item => item.name === 'markdown.showPreview'), false);
  assert(h.documents.some(document => document.languageId === 'markdown' && document.getText() === '# Drift'));
  await h.commands.get('elf.resource')({ figmaUrl: 'https://www.figma.com/design/file' });
  assert.equal(h.opened.length, 1);
  await h.commands.get('elf.resource')({ figmaUrl: 'https://evil.test/design/file' });
  assert.match(h.errors.at(-1), /Invalid Figma resource link/);
  h.quickPicks.push({ label: 'Cursor', value: 'cursor' });
  h.infoResponses.push('Copy snippet');
  await h.commands.get('elf.assistants')();
  assert.match(h.clipboard.at(-1), /mcpServers/);
});

test('description review opens a native diff and saves with the review hash', async t => {
  const h = harness(); t.after(() => h.native.dispose());
  h.files.set('/project/components/Button.figma.json', Buffer.from('{"layoutMode":"VERTICAL"}'));
  await h.commands.get('elf.prepareDescription')('Button');
  const diff = h.executed.find(item => item.name === 'vscode.diff');
  assert(diff);
  const draft = diff.args[1];
  assert.match(draft.fsPath, /\.draft\.json$/);
  assert.match(h.files.get(draft.fsPath).toString(), /HORIZONTAL/);
  h.vscode.window.visibleTextEditors = [{ document: { uri: draft, getText: () => JSON.stringify({ layoutMode: 'HORIZONTAL', fill: 'color.brand' }) } }];
  h.warningResponses.push('Save reviewed description');
  await h.commands.get('elf.saveDescription')();
  const saved = h.requests.find(request => request.path === '/api/project/save-description');
  assert.equal(JSON.parse(saved.body).reviewHash, 'a'.repeat(64));
  assert.equal(JSON.parse(saved.body).description.fill, 'color.brand');
  assert.equal(h.files.has(draft.fsPath), false);
  assert.equal(h.files.has(diff.args[0].fsPath), false);
});

test('diagnostics summarize drift status and activity changes stay grouped', async t => {
  const h = harness({ activity: [{ id: 'a1', at: '2026-10-27T00:00:00.000Z', type: 'sync', message: '1 resource synced', changes: [{ kind: 'token', key: 'color.brand', name: 'color.brand', action: 'update', before: '#fff', after: '#000' }] }] });
  t.after(() => h.native.dispose());
  h.files.set('/project/drift-status.json', Buffer.from(JSON.stringify({ driftFound: true, valueMismatches: 2, missingInCode: 1, missingInFigma: 0, componentsOutOfDate: 3, componentsChangedInFigma: 0, componentsInCodeNotInFigma: 0, componentsInFigmaNotInCode: 0, deprecationOverdue: 0, safeToRemoveFromDeprecations: 1, deprecatedStillInCode: 0 })));
  await h.native.refresh();
  const roots = await h.native.getChildren();
  const diagnostics = roots.find(item => item.label === 'Drift details');
  assert(diagnostics);
  const rows = await h.native.getChildren(diagnostics);
  assert.equal(rows.find(item => item.label === 'Value mismatches').description, '2');
  assert.equal(rows.find(item => item.label === 'Components out of date').description, '3');
  assert.equal(rows.find(item => item.label === 'Safe to remove from the deprecations list').description, '1');
  const activity = await h.native.getChildren(undefined, 'activity');
  const group = activity.find(item => item.label === '1 resource synced');
  assert.equal(group.kind, 'group');
  assert.equal(group.description, '1 change');
  const changes = await h.native.getChildren(group);
  assert.equal(changes[0].label, 'color.brand');
  assert.equal(changes[0].description, 'update · token');
  assert.match(changes[0].tooltip, /#fff/);
});

test('new activity is announced as native VS Code notifications', async t => {
  const h = harness({ activity: [{ id: 'a1', at: '2026-10-27T00:00:00.000Z', type: 'check', message: 'Drift found' }] });
  t.after(() => h.native.dispose());
  await h.native.refresh();
  assert.equal(h.infoMessages.length, 0);
  h.project.activity = [
    { id: 'a2', at: '2026-10-27T00:01:00.000Z', type: 'sync', message: '2 resources synced.' },
    { id: 'a1', at: '2026-10-27T00:00:00.000Z', type: 'check', message: 'Drift found' },
  ];
  await h.native.refresh();
  assert.deepEqual(h.infoMessages.map(item => item.message), ['Elf: 2 resources synced.']);
  assert.deepEqual(h.infoMessages[0].actions, ['Open Elf']);
  assert.equal(h.requests.some(request => request.path === '/api/project/pairing-code'), false);
});

test('repeated checks and errors are not announced again', async t => {
  const h = harness({ activity: [{ id: 'a1', at: '2026-10-27T00:00:00.000Z', type: 'check', message: 'Drift found' }] });
  t.after(() => h.native.dispose());
  await h.native.refresh();
  h.project.activity = [
    { id: 'c2', at: '2026-10-27T00:01:00.000Z', type: 'check', message: '143 drift items remain.' },
    { id: 'a1', at: '2026-10-27T00:00:00.000Z', type: 'check', message: 'Drift found' },
  ];
  await h.native.refresh();
  assert.deepEqual(h.infoMessages.map(item => item.message), ['Elf: 143 drift items remain.']);
  h.project.activity = [
    { id: 'c3', at: '2026-10-27T00:02:00.000Z', type: 'check', message: '143 drift items remain.' },
    ...h.project.activity,
  ];
  await h.native.refresh();
  assert.equal(h.infoMessages.length, 1);
  h.project.activity = [
    { id: 'e1', at: '2026-10-27T00:03:00.000Z', type: 'error', message: 'Figma disconnected.' },
    ...h.project.activity,
  ];
  await h.native.refresh();
  assert.deepEqual(h.warningMessages.map(item => item.message), ['Elf: Figma disconnected.']);
  h.project.activity = [
    { id: 'e2', at: '2026-10-27T00:04:00.000Z', type: 'error', message: 'Figma disconnected.' },
    ...h.project.activity,
  ];
  await h.native.refresh();
  assert.equal(h.warningMessages.length, 1);
});

test('pairing status stays passive in Overview and connection actions live in Manage', async t => {
  const h = harness(); t.after(() => h.native.dispose());
  await h.native.refresh();
  const roots = await h.native.getChildren();
  const file = roots.find(item => item.label === 'Figma file');
  assert.equal(file.description, 'Design'); assert.equal(file.command, undefined);
  assert.equal(h.requests.some(request => request.path === '/api/project/pairing-code'), false);
  h.quickPicks.push({ label: 'Figma account', command: 'elf.figma' });
  await h.native.manage();
  assert(h.executed.some(item => item.name === 'elf.figma'));
});

test('untrusted workspaces cannot issue native API requests', async t => {
  const h = harness({ trusted: false }); t.after(() => h.native.dispose());
  assert.equal((await h.native.getChildren())[0].label, 'Trust this workspace to use Elf');
  await h.commands.get('elf.check')();
  assert.equal(h.requests.length, 0);
  assert.match(h.errors.at(-1), /Trust this workspace/);
});

test('package contributions expose the native view, commands, and title actions', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
  assert.deepEqual(pkg.contributes.views.elf.map(view => view.id), ['elf.overview', 'elf.changes', 'elf.activityView']);
  assert.equal(pkg.contributes.viewsContainers.activitybar[0].id, 'elf');
  assert(pkg.contributes.commands.some(command => command.command === 'elf.settings'));
  assert(pkg.contributes.menus['view/title'].some(item => item.command === 'elf.reviewSync'));
  assert(pkg.contributes.menus['view/item/context'].some(item => item.command === 'elf.prepareDescription'));
  assert.equal(readFileSync(join(__dirname, '../src/extension.cjs'), 'utf8').includes('settings-panel'), false);
});

test('failed checks are labelled as failures, including when no count is present', async t => {
  const h = harness({ lastCheck: { status: 'failed', message: 'Plugin disconnected' } });
  t.after(() => h.native.dispose());
  await h.native.refresh();
  const roots = await h.native.getChildren();
  assert(roots.some(item => item.label === 'Check failed'));
  assert.equal(roots.some(item => item.label === '0 differences'), false);
});

test('preparing the same component twice preserves the earlier editable draft', async t => {
  const h = harness(); t.after(() => h.native.dispose());
  await h.native.prepareDescription('Button');
  const first = h.executed.find(item => item.name === 'vscode.diff').args[1];
  h.files.set(first.fsPath, Buffer.from('user edited draft'));
  await h.native.prepareDescription('Button');
  const diffs = h.executed.filter(item => item.name === 'vscode.diff');
  assert.notEqual(first.fsPath, diffs[1].args[1].fsPath);
  assert.equal(h.files.get(first.fsPath).toString(), 'user edited draft');
});

test('changing the plan during replacement confirmation blocks the write', async t => {
  const h = harness({ plan: { id: 'plan-2', entries: [{ kind: 'component', name: 'Button' }], issues: [{ kind: 'conflict', blocksApply: true }] } });
  t.after(() => h.native.dispose());
  await h.native.refresh(); await h.native.reviewSync(); h.native.toggleReplace();
  h.vscode.window.showWarningMessage = async () => { h.native.cancelPlan(); return 'Replace and apply'; };
  await assert.rejects(h.native.applySync(), /review changed/);
  assert.equal(h.requests.some(request => request.path === '/api/project/apply'), false);
});

test('inline resource actions unwrap the selected tree row', async t => {
  const h = harness(); t.after(() => h.native.dispose()); await h.native.refresh();
  const resources = await h.native.resourceChildren();
  await h.commands.get('elf.resource')(resources[0]);
  assert.equal(h.opened[0].toString(), 'https://www.figma.com/design/file');
});

test('report and activity documents use a read-only provider rather than unsaved editor buffers', async t => {
  const h = harness(); t.after(() => h.native.dispose());
  await h.native.report();
  const document = h.documents.at(-1);
  assert.equal(document.uri.scheme, 'elf-readonly');
  assert.equal(document.isUntitled, false);
  assert.equal(document.getText(), '# Drift');
});
