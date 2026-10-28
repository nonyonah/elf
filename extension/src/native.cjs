const { publicLink } = require('./api-policy.cjs');
const { generateDescription } = require('./ai-description.cjs');
const { join, basename } = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { reportSection, compactActivity } = require('./report-details.cjs');
const { tmpdir } = require('node:os');

function row(label, command, description, icon = 'circle-outline', argument, options = {}) {
  return {
    kind: 'row', label, description, icon,
    command: command ? { command, title: label, arguments: argument === undefined ? [] : [argument] } : undefined,
    ...options,
  };
}

function section(label, icon, children, options = {}) {
  return {
    kind: 'section', label, icon, children, collapsible: true,
    expanded: options.expanded !== false, description: options.description,
    color: options.color, tooltip: options.tooltip,
  };
}

function group(label, children, options = {}) {
  return {
    kind: 'group', label, icon: options.icon || 'list-flat', children, collapsible: true,
    expanded: options.expanded !== false, description: options.description,
    color: options.color, tooltip: options.tooltip,
  };
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

class NativeElf {
  constructor(vscode, context, getRuntime, ensureRuntime) {
    this.vscode = vscode; this.context = context; this.getRuntime = getRuntime; this.ensureRuntime = ensureRuntime;
    this.events = new vscode.EventEmitter(); this.onDidChangeTreeData = this.events.event;
    this.snapshot = null; this.resources = null; this.resourceError = null; this.status = null;
    this.error = null; this.refreshing = null; this.plan = null; this.planAuto = false; this.planReplace = false;
    this.activityRoot = null; this.seenActivity = new Set(); this.lastCheckMessage = null; this.lastErrorMessage = null;
    this.drafts = new Map(); this.documents = new Map();
    if (vscode.languages?.registerCompletionItemProvider) context.subscriptions.push(vscode.languages.registerCompletionItemProvider({ scheme: 'file', pattern: '**/description-drafts/*.draft.json' }, {
      provideCompletionItems: (document, position) => {
        const draft = this.drafts.get(document.uri.toString());
        if (!draft || draft.owner !== this.getRuntime()) return [];
        const line = document.lineAt(position.line).text.slice(0, position.character);
        const match = /"([^"]+)"\s*:\s*"[^"\n]*$/.exec(line);
        if (!match) return [];
        const expected = ['fill', 'color'].includes(match[1]) ? 'COLOR' : match[1] === 'fontFamily' ? 'STRING' : ['gap', 'cornerRadius', 'all', 'top', 'right', 'bottom', 'left', 'weight', 'fontSize'].includes(match[1]) ? 'FLOAT' : null;
        if (!expected) return [];
        return (draft.prepared.tokens || []).filter(token => token.type === expected).map(token => {
          const item = new vscode.CompletionItem(token.key, vscode.CompletionItemKind.Variable);
          item.detail = `${token.type} · ${token.name}`; item.insertText = token.key;
          item.range = new vscode.Range(position.line, line.lastIndexOf('"') + 1, position.line, position.character);
          return item;
        });
      },
    }, '"', '{'));
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('elf-readonly', { provideTextDocumentContent: uri => this.documents.get(uri.toString()) || '' }));
    this.view = vscode.window.createTreeView('elf.overview', { treeDataProvider: this, showCollapseAll: true });
    this.changesView = vscode.window.createTreeView('elf.changes', { treeDataProvider: this.provider('changes'), showCollapseAll: true });
    this.activityView = vscode.window.createTreeView('elf.activityView', { treeDataProvider: this.provider('activity'), showCollapseAll: true });
    context.subscriptions.push(this.view, this.changesView, this.activityView, this.events);
    const register = (name, action) => context.subscriptions.push(vscode.commands.registerCommand(name, async (...args) => {
      try {
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before using Elf.');
        await action(...args.map(value => value?.kind === 'row' && value.command?.arguments?.length ? value.command.arguments[0] : value));
      } catch (error) {
        void vscode.window.showErrorMessage(error.message);
      }
    }));
    register('elf.manage', () => this.manage());
    register('elf.importTokens', () => this.importTokens());
    register('elf.applyTokenImport', () => this.applyTokenImport());
    register('elf.cancelTokenImport', () => {this.tokenImport=null;this.events.fire();});
    register('elf.refresh', () => this.refresh({ resources: true }));
    register('elf.restartBridge', async () => {
      let runtime = this.getRuntime();
      if (!runtime) { try {await this.ensureRuntime();} catch {} runtime = this.getRuntime(); }
      if (!runtime) throw new Error('Start Elf once before restarting its bridge.');
      if (await this.vscode.window.showWarningMessage('Restart the shared bridge? Monitoring stops briefly and plugin-only approval must be renewed. Saved pairing is retained. Active MCP clients must close first.',{modal:true},'Restart bridge') !== 'Restart bridge') return;
      await runtime.restartBridge(); await this.show();
    });
    register('elf.setup', () => this.setup());
    register('elf.check', () => this.check());
    register('elf.monitor', () => this.monitor());
    register('elf.toggleAutomatic', () => this.toggleAutomatic());
    register('elf.reviewSync', automatic => this.reviewSync(automatic === true));
    register('elf.applySync', () => this.applySync());
    register('elf.reviewResource', async entry => {
      if (!entry) {
        const plan = await this.api('/api/project/plan','POST',{});
        entry = await this.vscode.window.showQuickPick((plan.entries || []).map(item => ({label:item.name,description:item.kind,kind:item.kind,key:item.key})),{title:'Review one resource sync'});
        if (!entry) return;
      }
      await this.reviewSync(false, entry);
    });
    register('elf.saveAndReviewDescription', uri => this.saveDescription(uri, true));
    register('elf.cancelPlan', () => this.cancelPlan());
    register('elf.toggleReplace', () => this.toggleReplace());
    register('elf.toggleEnableAuto', () => this.toggleEnableAuto());
    register('elf.approveDocument', () => this.approveDocument());
    register('elf.authorizationMode', () => this.authorizationMode());
    register('elf.figma', () => this.account('figma'));
    register('elf.pairing', () => this.pairing());
    register('elf.disconnectFigma', () => this.disconnectFigma());
    register('elf.slack', () => this.account('slack'));
    register('elf.slackTest', () => this.slackTest());
    register('elf.toggleNotify', () => this.toggleNotify());
    register('elf.toggleOnlyOnChange', () => this.toggleOnlyOnChange());
    register('elf.notifications', () => this.notifications());
    register('elf.preferences', () => this.preferences());
    register('elf.prepareDescription', component => this.prepareDescription(component));
    register('elf.generateDescription', component => this.prepareDescription(component, true));
    register('elf.recoverDescription', () => this.recoverDescription());
    register('elf.descriptionContext', () => this.descriptionContext());
    register('elf.saveDescription', () => this.saveDescription());
    register('elf.resource', resource => this.openResource(resource));
    register('elf.activity', item => this.openActivity(item));
    register('elf.assistants', () => this.assistants());
    register('elf.report', () => this.report());
    register('elf.driftDetail', detail => this.driftDetail(detail));
    if (vscode.workspace.onDidCloseTextDocument) context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
      this.documents.delete(document.uri.toString());
      const draft = this.drafts.get(document.uri.toString());
      if (!draft) return;
      this.drafts.delete(document.uri.toString());
      try { void Promise.resolve(this.vscode.workspace.fs.delete(draft.uri, { useTrash: false })).catch(() => {}); } catch {}
      if (draft.before) { try { void Promise.resolve(this.vscode.workspace.fs.delete(draft.before, { useTrash: false })).catch(() => {}); } catch {} }
    }));
    if (vscode.window.onDidChangeWindowState) context.subscriptions.push(vscode.window.onDidChangeWindowState(state => { if (state.focused) void this.refresh(); }));
    this.timer = setInterval(() => { if (this.getRuntime()?.state === 'running') void this.refresh(); }, 5000);
    this.timer.unref?.();
  }
  dispose() {
    clearInterval(this.timer);
    this.view.dispose(); this.changesView.dispose(); this.activityView.dispose();
    this.events.dispose();
  }
  invalidate() {
    if (this.getRuntime()?.state !== 'running') {
      this.snapshot = null; this.resources = null; this.resourceError = null; this.status = null;
      this.plan = null; this.planAuto = false; this.planReplace = false;
      this.activityRoot = null; this.seenActivity.clear(); this.lastCheckMessage = null; this.lastErrorMessage = null;
    }
    void this.vscode.commands.executeCommand('setContext', 'elf.hasPlan', Boolean(this.plan));
    this.events.fire();
  }
  async api(path, method = 'GET', body, expectedOwner) {
    const runtime = await this.ensureRuntime();
    if (!runtime || !this.vscode.workspace.isTrusted) throw new Error('Open a trusted local project first.');
    if (expectedOwner && runtime !== expectedOwner) throw new Error('The project changed. Review this action again.');
    const response = await runtime.request(path, method, body === undefined ? undefined : JSON.stringify(body));
    let data;
    try { data = JSON.parse(response.body); } catch { throw new Error('Elf returned an unreadable response. Restart Elf.'); }
    if (response.status < 200 || response.status >= 300) throw new Error(data.error === 'Unknown project action.' ? 'This Elf runtime needs an update. Reload the editor after updating Elf.' : data.error || 'Elf could not complete this action.');
    return data;
  }
  async refresh(options = {}) {
    if (!this.vscode.workspace.isTrusted || this.getRuntime()?.state !== 'running') { this.invalidate(); return; }
    if (options.resources) { this.resources = null; this.resourceError = null; }
    if (this.refreshing) return this.refreshing;
    const owner = this.getRuntime();
    this.refreshing = (async () => {
      try {
        const [config, figma, status] = await Promise.all([this.api('/api/config'), this.api('/api/figma/account'), this.readStatus(owner.root)]);
        if (owner !== this.getRuntime() || owner.state !== 'running') return;
        this.snapshot = { config, figma, project: config.onboarding }; this.status = status; this.error = null;
        this.announceActivity(owner.root, this.snapshot.project?.activity);
      } catch (error) { this.error = error.message; }
      finally { this.events.fire(); }
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async readStatus(root) {
    try {
      const raw = await this.vscode.workspace.fs.readFile(this.vscode.Uri.joinPath(this.vscode.Uri.file(root), 'drift-status.json'));
      const status = JSON.parse(Buffer.from(raw).toString('utf8'));
      return status && typeof status === 'object' ? status : null;
    } catch { return null; }
  }
  announceActivity(root, activity) {
    const items = Array.isArray(activity) ? activity.filter(item => item && typeof item.id === 'string') : [];
    if (this.activityRoot !== root) {
      this.activityRoot = root;
      this.seenActivity = new Set(items.map(item => item.id));
      this.lastCheckMessage = (() => { const check = items.find(item => item.type === 'check'); return check?.fingerprint || check?.message || null; })();
      this.lastErrorMessage = items.find(item => item.type === 'error')?.message ?? null;
      return;
    }
    const fresh = items.filter(item => !this.seenActivity.has(item.id)).reverse();
    for (const item of fresh) this.seenActivity.add(item.id);
    const selected = [];
    for (const item of fresh) {
      if (item.type === 'check') {
        const key = item.fingerprint || item.message;
        if (key === this.lastCheckMessage) continue;
        this.lastCheckMessage = key;
      } else if (item.type === 'error') {
        if (item.message === this.lastErrorMessage) continue;
        this.lastErrorMessage = item.message;
      } else if (item.type === 'sync' && /^Applying \d+ reviewed resource changes\.$/.test(item.message)) continue;
      else if (!['sync', 'conflict', 'description'].includes(item.type)) continue;
      selected.push(item);
    }
    for (const item of selected.slice(-3)) this.notifyActivity(item);
  }
  notifyActivity(item) {
    const actions = item.type === 'check' ? ['View report', 'Open Elf'] : ['Open Elf'];
    const message = `Elf: ${item.message}`;
    const pending = item.type === 'error' || item.type === 'conflict'
      ? this.vscode.window.showWarningMessage(message, ...actions)
      : this.vscode.window.showInformationMessage(message, ...actions);
    void Promise.resolve(pending).then(choice => {
      if (choice === 'View report') void this.vscode.commands.executeCommand('elf.report');
      else if (choice === 'Open Elf') void this.vscode.commands.executeCommand('workbench.view.extension.elf');
    }).catch(() => {});
  }
  getTreeItem(element) {
    const state = element.collapsible
      ? element.expanded === false ? this.vscode.TreeItemCollapsibleState.Collapsed : this.vscode.TreeItemCollapsibleState.Expanded
      : this.vscode.TreeItemCollapsibleState.None;
    const item = new this.vscode.TreeItem(element.label, state);
    item.id = element.id;
    item.description = element.description || undefined;
    item.tooltip = element.tooltip || element.description || element.label;
    item.command = element.command;
    item.contextValue = element.contextValue;
    item.iconPath = element.color
      ? new this.vscode.ThemeIcon(element.icon || 'circle-outline', new this.vscode.ThemeColor(element.color))
      : new this.vscode.ThemeIcon(element.icon || 'circle-outline');
    return item;
  }
  provider(view) {
    return { onDidChangeTreeData: this.onDidChangeTreeData, getTreeItem: element => this.getTreeItem(element), getChildren: element => this.getChildren(element, view) };
  }
  async getChildren(element, view = 'overview') {
    const runtime = this.getRuntime();
    if (!element) {
      if (!this.vscode.workspace.isTrusted) return [row('Trust this workspace to use Elf', null, 'Local project required', 'lock')];
      if (!runtime || runtime.state !== 'running') {
        const state = runtime?.state || 'stopped';
        return [row(state === 'starting' ? 'Starting Elf…' : 'Start Elf', 'elf.start', state, state === 'failed' ? 'warning' : 'play')];
      }
      if (!this.snapshot) return [row(this.error || 'Load project status', 'elf.refresh', this.error ? 'Retry' : 'Loading…', this.error ? 'warning' : 'refresh')];
      if (view === 'changes') return [...this.syncChildren(), group('Project components', () => this.componentChildren(), { expanded: true, icon: 'symbol-class' }), group('Synced resources', () => this.resourceChildren(), { expanded: false, icon: 'symbol-color' })];
      if (view === 'activity') return this.activityChildren();
      return this.overviewChildren();
    }
    if (element.kind === 'section' || element.kind === 'group') {
      const children = typeof element.children === 'function' ? await element.children() : element.children;
      return children || [];
    }
    return [];
  }
  overviewChildren() {
    const project = this.snapshot.project;
    const last = project?.lastCheck;
    const summary = project?.checking ? 'Checking…' : !last ? 'Not checked' : last.status === 'failed' ? 'Check failed' : last.status === 'clean' ? 'No drift' : `${last.total ?? 'Some'} differences`;
    const mode = !project?.configured ? 'Setup needed' : !project?.running ? 'Monitoring paused' : project.mode === 'automatic' ? 'Automatic sync' : 'Monitoring';
    const file = project?.bridge?.connected ? project.bridge.file?.name || 'Connected' : 'Plugin disconnected';
    return [
      row(basename(project?.root || this.getRuntime().root), null, mode, 'folder', undefined, { tooltip: project?.root }),
      row('Figma file', null, file, 'link'),
      ...(project?.bridge?.pendingApproval ? [row('Approve open Figma document', 'elf.approveDocument', project.bridge.pendingApproval.name, 'shield')] : []),
      ...(project?.bridge?.file?.authorization === 'plugin' ? [row('Document approved for this connection', null, 'URL not independently verified', 'shield')] : []),
      ...(project?.authorization !== 'plugin' && this.snapshot.figma?.verificationLimit ? [row('Figma verification paused', null, `Retry after ${new Date(this.snapshot.figma.verificationLimit.retryAt).toLocaleString()}`, 'clock', undefined, { tooltip: 'Figma imposed a REST API rate limit. Reconnecting the account does not bypass it. Saved pairing remains unchanged.' })] : []),
      row(summary, 'elf.report', last?.checkedAt ? new Date(last.checkedAt).toLocaleTimeString() : undefined, last?.status === 'failed' ? 'error' : last?.status === 'drift' ? 'warning' : 'pulse'),
      ...(!project?.running ? [row(project?.configured ? 'Resume monitoring' : 'Set up project', 'elf.setup', null, 'play')] : []),
      ...(this.error || project?.error || project?.attention ? [row('Needs attention', 'elf.report', this.error || project.error || project.attention, 'warning')] : []),
      group('Drift details', this.diagnosticChildren(), { expanded: false, icon: 'list-unordered' }),
    ];
  }
  async manage() {
    const runtime = await this.ensureRuntime();
    if (!runtime) return;
    await this.refresh();
    const { config, figma, project } = this.snapshot || {};
    const options = [
      { label: 'Approve open Figma document', description: project?.bridge?.pendingApproval?.name || 'Plugin-only mode; fresh approval each connection', command: 'elf.approveDocument' },
      { label: 'Figma authorization mode', description: 'Plugin approval or strict URL verification', command: 'elf.authorizationMode' },
      { label: 'Figma account', description: figma?.connected ? 'Connected · disconnect' : 'Connect', command: 'elf.figma' },
      { label: 'Figma plugin pairing', description: project?.bridge?.connected ? 'Connected · show pairing code' : 'Pair file', command: 'elf.pairing' },
      ...(project?.bridge?.connected ? [{ label: 'Disconnect file pairing', command: 'elf.disconnectFigma' }] : []),
      { label: 'Slack', description: config?.slack?.connected ? `${config.slack.channel || 'Connected'} · disconnect` : 'Connect', command: 'elf.slack' },
      ...(config?.slack?.connected ? [{ label: 'Send Slack test message', command: 'elf.slackTest' }] : []),
      { label: 'Notification preferences', command: 'elf.preferences' },
      { label: 'Import Figma tokens', description:'Preview a new JSON file; existing files stay unchanged', command:'elf.importTokens' },
      { label: 'Coding assistants', description: 'Cursor, Claude Code, Codex', command: 'elf.assistants' },
      { label: 'Automatic sync', description: project?.mode === 'automatic' ? 'On · pause' : 'Off · review before enabling', command: 'elf.toggleAutomatic' },
      { label: 'Generate component description with AI', command: 'elf.generateDescription' },
      { label: 'Prepare component description manually', command: 'elf.prepareDescription' },
      { label: 'Description source and token context', command: 'elf.descriptionContext' },
      { label: 'Recover open description draft', command: 'elf.recoverDescription' },
      { label: 'Save reviewed description', command: 'elf.saveDescription' },
      { label: 'Stop Elf', command: 'elf.stop' },
      { label: 'Restart shared bridge', description: 'Preserves saved pairings; close MCP sessions first', command: 'elf.restartBridge' },
    ];
    const choice = await this.vscode.window.showQuickPick(options, { title: 'Manage Elf', placeHolder: 'Connections, preferences, and project tools' });
    if (choice?.command) await this.vscode.commands.executeCommand(choice.command);
  }
  syncChildren() {
    const project = this.snapshot?.project;
    const automatic = project?.mode === 'automatic';
    const children = [row('Review code changes', 'elf.reviewSync', 'Preview before syncing', 'git-compare')];
    for (const [uri, draft] of this.drafts) if (draft.owner === this.getRuntime()) children.push(row(`Save and review ${draft.prepared.name} sync`, 'elf.saveAndReviewDescription', 'Description draft ready', 'check', uri));
    if (this.tokenImport && this.tokenImportOwner===this.getRuntime()) children.push(group('Figma → code token import',[
      row(this.tokenImport.path,null,`${this.tokenImport.names.length} new tokens`,'file-code'),
      ...this.tokenImport.issues.map(issue => row(issue,null,null,'info')),
      row('Apply reviewed token import','elf.applyTokenImport','Creates the reviewed JSON file','check'),
      row('Cancel token import','elf.cancelTokenImport',null,'close'),
    ]));
    if (!this.plan) return children;
    const conflicts = this.plan.issues?.some(issue => issue.kind === 'conflict' && issue.blocksApply !== false);
    const unresolved = this.plan.issues?.some(issue => issue.kind !== 'unsupported');
    if (this.plan.entries?.length) {
      children.push(group(`${this.plan.entries.length} planned ${this.plan.entries.length === 1 ? 'change' : 'changes'}`, this.plan.entries.map(entry => row(entry.name, 'elf.reviewResource', `${entry.kind} · ${entry.action === 'create' ? 'Create' : 'Update'}`, entry.kind === 'component' ? 'symbol-class' : entry.kind === 'style' ? 'symbol-enum' : 'symbol-color', {kind:entry.kind,key:entry.key}, {contextValue:'elf.sync-resource',tooltip:'Review just this resource and its required dependencies'}))));
    } else {
      children.push(row('No supported changes to apply', null, 'Review the issues below', 'info'));
    }
    if (this.plan.issues?.length) {
      children.push(group(`${this.plan.issues.length} ${this.plan.issues.length === 1 ? 'item needs' : 'items need'} attention`, this.plan.issues.map(issue => row(
        issue.message,
        issue.action === 'prepare-component' && issue.component ? 'elf.prepareDescription' : null,
        issue.action === 'prepare-component' ? 'Prepare description' : issue.kind,
        'warning',
        issue.component,
        { contextValue: issue.action ? 'elf.issue' : undefined, tooltip: issue.message },
      ))));
    }
    if (conflicts) children.push(row('Replace Figma edits affecting planned changes', 'elf.toggleReplace', this.planReplace ? 'On' : 'Off', this.planReplace ? 'checkbox' : 'square'));
    if (!automatic && !this.planSelection) children.push(row('Keep syncing supported changes after this review', 'elf.toggleEnableAuto', unresolved ? 'Unavailable' : this.planAuto ? 'On' : 'Off', this.planAuto ? 'checkbox' : 'square', undefined, { tooltip: unresolved ? 'Resolve conflicts and removed resources first.' : 'Keep automatic sync enabled after applying this review.' }));
    if (this.plan.entries?.length || this.planAuto) children.push(row(this.planAuto ? 'Apply and enable automatic sync' : 'Apply sync', 'elf.applySync', null, 'check', undefined, { color: 'charts.green', contextValue: 'elf.plan-action' }));
    children.push(row('Cancel review', 'elf.cancelPlan', null, 'close'));
    return children;
  }
  diagnosticChildren() {
    const status = this.status;
    if (!status) return [row('Run Check now to load drift details', 'elf.check', null, 'refresh')];
    const counts = [
      ['Value mismatches', status.valueMismatches],
      ['Missing in code', status.missingInCode],
      ['Missing in Figma', status.missingInFigma],
      ['Components out of date', status.componentsOutOfDate],
      ['Components changed in Figma', status.componentsChangedInFigma],
      ['Components in code, not in Figma', status.componentsInCodeNotInFigma],
      ['Components in Figma, not in code', status.componentsInFigmaNotInCode],
      ['Deprecations overdue', status.deprecationOverdue],
    ];
    const rows = counts.filter(([, count]) => Number(count) > 0).map(([label, count]) => group(label, () => this.driftChildren(label), { description: String(count), expanded: false, icon: 'warning' }));
    if (Number(status.safeToRemoveFromDeprecations) > 0) rows.push(group('Safe to remove from the deprecations list', () => this.driftChildren('Safe to remove from the deprecations list'), { description: String(status.safeToRemoveFromDeprecations), expanded: false }));
    if (Number(status.deprecatedStillInCode) > 0) rows.push(group('Deprecated (still in code)', () => this.driftChildren('Deprecated (still in code)'), { description: String(status.deprecatedStillInCode), expanded: false }));
    if (!rows.length && this.snapshot?.project?.lastCheck?.status === 'failed') return [row('Last check failed', 'elf.check', 'Retry', 'error')];
    return rows.length ? rows : [row('No drift detected', 'elf.report', 'Clean', 'pass', undefined, { color: 'charts.green' })];
  }
  async resourceChildren() {
    if (this.resourceError) return [row(this.resourceError, 'elf.refresh', 'Retry', 'warning')];
    if (this.resources === null) {
      try { this.resources = (await this.api('/api/project/resources', 'POST', {})).resources || []; }
      catch (error) { this.resourceError = error.message; return [row(error.message, 'elf.refresh', 'Retry', 'warning')]; }
    }
    return this.resources.length
      ? this.resources.map(resource => row(resource.name, 'elf.resource', resource.verified ? 'Verified' : resource.recorded ? 'Sync recorded' : 'Needs review', 'symbol-color', resource, { color: resource.verified ? 'charts.green' : undefined, contextValue: 'elf.resource' }))
      : [row('No synced resources yet', null, 'Run Review sync to create resources', 'info')];
  }
  activityChildren() {
    const prefs = this.notificationState();
    const items = compactActivity(this.snapshot?.project?.activity || []).filter(item => !prefs.cleared.includes(item.id));
    return [
      row('Mark read or clear notifications', 'elf.notifications', null, 'check-all'),
      ...items.slice(0, 100).map(item => Array.isArray(item.changes) && item.changes.length
        ? group(item.message, item.changes.slice(0, 200).map(change => row(change.name, 'elf.activity', `${change.action} · ${change.kind}`, 'diff', { ...item, changes: [change] }, { tooltip: `${change.before ?? '∅'} → ${change.after}`, contextValue: 'elf.activity' })), { description: `${item.changes.length} ${item.changes.length === 1 ? 'change' : 'changes'}`, icon: item.type === 'error' || item.type === 'conflict' ? 'warning' : 'bell', expanded: false, color: item.type === 'error' || item.type === 'conflict' ? 'charts.yellow' : undefined })
        : row(item.message, 'elf.activity', prefs.read.includes(item.id) ? 'Read' : 'Unread', item.type === 'error' || item.type === 'conflict' ? 'warning' : 'bell', item, { color: item.type === 'error' || item.type === 'conflict' ? 'charts.yellow' : undefined, contextValue: 'elf.activity' })),
    ];
  }
  async show() {
    const runtime = await this.ensureRuntime();
    if (!runtime) return;
    const current = runtime;
    const deadline = Date.now() + 20_000;
    while (runtime === current && runtime.state === 'starting' && Date.now() < deadline) await delay(100);
    await this.vscode.commands.executeCommand('workbench.view.extension.elf');
    await this.refresh();
  }
  async setup() {
    const status = await this.api('/api/onboarding');
    if (!status.bridge?.connected) throw new Error('Connect your Figma account, then pair and open the Figma file before setting up monitoring.');
    if (!status.configured) await this.api('/api/onboarding/validate', 'POST', { tokenPath: 'auto', source: 'auto', autoSync: false });
    const choice = await this.vscode.window.showInformationMessage(`Monitor ${status.root} against ${status.bridge.file?.name || 'the paired Figma file'}? Elf will discover token and component sources automatically.`, { modal: true }, 'Set up monitoring');
    if (choice !== 'Set up monitoring') return;
    if (!status.configured) await this.api('/api/onboarding', 'POST', { tokenPath: 'auto', source: 'auto', autoSync: false });
    await this.api('/api/onboarding/start', 'POST', {});
    await this.refresh({ resources: true });
  }
  async check() {
    await this.api('/api/project/check', 'POST', {});
    await this.refresh({ resources: true });
  }
  async monitor() {
    await this.api('/api/project/monitor', 'POST', {});
    await this.refresh();
  }
  async toggleAutomatic() {
    if (this.snapshot?.project?.mode === 'automatic') {
      if (await this.vscode.window.showWarningMessage('Pause automatic sync? Monitoring continues and Figma will not be written automatically.', { modal: true }, 'Pause automatic sync') !== 'Pause automatic sync') return;
      await this.monitor();
      return;
    }
    await this.reviewSync(true);
  }
  async approveDocument() {
    const owner = await this.ensureRuntime();
    const pending = await this.api('/api/project/pending-document', 'POST', {});
    if (!pending) throw new Error('In the Figma plugin, choose Plugin approval, enter this project’s file link, and connect first.');
    if (pending.expiresAt <= Date.now()) throw new Error('Document approval timed out. Reconnect the Figma plugin for a fresh approval request.');
    const approve = await this.vscode.window.showWarningMessage(`Authorize the currently open Figma document “${pending.file.name}” for ${owner.root}? Project link key: ${pending.file.key}. This switches this project to plugin-only authorization: the URL is not independently verified. Approval lasts only for this connection; automatic sync is paused.`, {modal:true}, 'Approve this document');
    if (approve !== 'Approve this document') return;
    await this.api('/api/project/approve-document', 'POST', {fileKey:pending.file.key,ticket:pending.ticket,optIn:true}, owner);
    await this.refresh({resources:true});
  }
  async authorizationMode() {
    const choice = await this.vscode.window.showQuickPick(['Plugin approval — no REST requests', 'Strict URL verification — REST required'], {title:'Figma document authorization'});
    if (!choice) return;
    if (choice.startsWith('Plugin')) return this.approveDocument();
    if (await this.vscode.window.showWarningMessage('Require strict URL verification for this project? An existing plugin-only connection will be closed, and Figma REST limits apply.', {modal:true}, 'Use strict verification') !== 'Use strict verification') return;
    await this.api('/api/project/strict-authorization','POST',{}); await this.refresh();
  }
  async account(provider) {
    const data = await this.api(provider === 'figma' ? '/api/figma/account' : '/api/config');
    const connected = provider === 'figma' ? data.connected : data.slack?.connected;
    const label = provider === 'figma' ? 'Figma' : 'Slack';
    if (connected) {
      if (await this.vscode.window.showWarningMessage(`Disconnect ${label}?`, { modal: true }, 'Disconnect') !== 'Disconnect') return;
      await this.api(`/api/${provider}/disconnect`, 'POST', {});
    } else {
      const authorization = await this.api(`/api/${provider}/connect`, 'POST', {});
      const url = new URL(authorization.url);
      if (url.protocol !== 'https:' || url.origin !== authorization.authorizationOrigin || url.username || url.password) throw new Error('Unexpected authorization address.');
      await this.vscode.env.openExternal(this.vscode.Uri.parse(url.href));
      void this.vscode.window.showInformationMessage(`Complete ${label} authorization in your browser, then return to Elf. Connection status refreshes automatically.`);
    }
    this.resources = null; await this.refresh();
  }
  async pairing() {
    const runtime = await this.ensureRuntime();
    if (!runtime) return;
    const result = await this.api('/api/project/pairing-code', 'POST', {});
    const pairing = result?.pairing;
    if (!pairing?.code) throw new Error('Could not obtain a fresh pairing code. Restart the updated Elf runtime and try again.');
    const choice = await this.vscode.window.showInformationMessage(`Pairing code: ${pairing.code}. It expires in five minutes.`, 'Copy code');
    if (choice === 'Copy code' && this.vscode.env.clipboard) await this.vscode.env.clipboard.writeText(pairing.code);
  }
  async disconnectFigma() {
    if (await this.vscode.window.showWarningMessage('Disconnect this Figma pairing? A new pairing code will be required to reconnect.', { modal: true }, 'Disconnect') !== 'Disconnect') return;
    await this.api('/api/project/disconnect-figma', 'POST', {});
    this.resources = null; await this.refresh();
  }
  async slackTest() {
    await this.api('/api/slack/test', 'POST', {});
    void this.vscode.window.showInformationMessage('Slack test message sent.');
  }
  async toggleNotify() {
    const config = await this.api('/api/config');
    await this.api('/api/config', 'PATCH', { notify: { enabled: !config.notify?.enabled } });
    await this.refresh();
  }
  async toggleOnlyOnChange() {
    const config = await this.api('/api/config');
    if (!config.notify?.enabled) throw new Error('Enable drift notifications before changing this setting.');
    await this.api('/api/config', 'PATCH', { notify: { onlyOnChange: config.notify.onlyOnChange === false } });
    await this.refresh();
  }
  async preferences() {
    const config = await this.api('/api/config');
    const selection = await this.vscode.window.showQuickPick([
      { label: 'Slack drift notifications', picked: Boolean(config.notify?.enabled), key: 'notify' },
      { label: 'Notify only when drift changes', picked: config.notify?.onlyOnChange !== false, key: 'onlyOnChange' },
    ], { title: 'Elf notification preferences', canPickMany: true });
    if (!selection) return;
    const selected = new Set(selection.map(item => item.key));
    const enabled = selected.has('notify');
    await this.api('/api/config', 'PATCH', { notify: enabled ? { enabled: true, onlyOnChange: selected.has('onlyOnChange') } : { enabled: false } });
    await this.refresh();
  }
  async importTokens() {
    const owner=await this.ensureRuntime(); if (!owner) return;
    const path=await this.vscode.window.showInputBox({title:'Import Figma tokens',prompt:'New JSON filename in this project. Existing code is never overwritten.',value:'figma.tokens.json'});
    if (!path) return;
    const plan=await this.api('/api/project/plan-token-import','POST',{path},owner);
    if (owner!==this.getRuntime()) throw new Error('The project changed. Review a fresh import.');
    this.tokenImport=plan;this.tokenImportOwner=owner;
    await this.text(plan.content,'json',`${plan.path} import preview`);
    this.events.fire();await this.vscode.commands.executeCommand('elf.changes.focus');
    void this.vscode.window.showInformationMessage(`Review ${plan.names.length} new tokens in ${plan.path}. ${plan.limitations.join(' ')} Apply through Changes when ready.`);
  }
  async applyTokenImport() {
    const plan=this.tokenImport; const owner=this.tokenImportOwner;
    if (!plan || owner!==this.getRuntime()) throw new Error('Review a token import in this project first.');
    if (await this.vscode.window.showWarningMessage(`Create ${plan.path} with ${plan.names.length} imported Figma tokens? This writes the reviewed file and pauses automatic sync.`,{modal:true},'Create token file')!=='Create token file') return;
    if (this.tokenImport!==plan || this.getRuntime()!==owner) throw new Error('The import review changed.');
    const result=await this.api('/api/project/apply-token-import','POST',{planId:plan.id},owner);
    this.tokenImport=null;await this.refresh({resources:true});
    void this.vscode.window.showInformationMessage(`${result.imported} tokens imported into ${result.path}.`);
  }
  async componentChildren() {
    const result = await this.api('/api/project/components', 'POST', {});
    return (result.components || []).map(component => group(component.name, [
      ...(component.descriptionStatus === 'needs-review' && !component.deprecated ? [row('Generate Figma description', 'elf.generateDescription', component.suggestion, 'sparkle', component.codeKey), row('Prepare description manually', 'elf.prepareDescription', null, 'edit', component.codeKey)] : []),
      ...(!component.deprecated ? [row('Review this component sync', 'elf.reviewResource', 'Includes required dependencies', 'git-compare', {kind:'component',key:component.codeKey}), row('Edit Figma description', 'elf.prepareDescription', null, 'edit', component.codeKey)] : []),
    ], {expanded:component.descriptionStatus === 'needs-review' && !component.deprecated,description:component.deprecated ? 'Deprecated · retained' : component.descriptionStatus === 'needs-review' ? 'Description needed' : 'Ready to review',icon:component.descriptionStatus === 'needs-review' ? 'lightbulb' : 'symbol-class'}));
  }
  async reviewSync(automatic = false, selection) {
    const owner = await this.ensureRuntime();
    const plan = await this.api('/api/project/plan', 'POST', selection ? {selection:{kind:selection.kind,key:selection.key}} : {});
    if (owner !== this.getRuntime()) throw new Error('The project changed. Review a fresh sync plan.');
    if (selection && (plan.selection?.key!==selection.key || plan.selection?.kind!==selection.kind)) throw new Error('Update and restart Elf before reviewing individual resources.');
    const unresolved = plan.issues?.some(issue => issue.kind !== 'unsupported');
    this.planSelection = selection;
    this.plan = plan; this.planOwner = this.getRuntime();
    this.planAuto = automatic && this.snapshot?.project?.mode !== 'automatic' && !unresolved;
    this.planReplace = false;
    void this.vscode.commands.executeCommand('setContext', 'elf.hasPlan', Boolean(this.plan));
    this.events.fire();
    await this.vscode.commands.executeCommand('elf.changes.focus');
    if (!plan.entries?.length) void this.vscode.window.showInformationMessage('No supported changes to apply. Review the listed issues.');
    else void this.vscode.window.showInformationMessage(`Review the ${plan.entries.length} planned ${plan.entries.length === 1 ? 'change' : 'changes'} in Elf, then apply. A fresh review is required if code or Figma changes.`);
  }
  async applySync() {
    if (!this.plan) throw new Error('Review sync before applying changes.');
    const plan = this.plan;
    if (this.planOwner !== this.getRuntime()) throw new Error('The project changed. Review a fresh sync plan.');
    const enableAuto = this.planAuto; const replace = this.planReplace;
    const conflicts = plan.issues?.some(issue => issue.kind === 'conflict' && issue.blocksApply !== false);
    const unresolved = plan.issues?.some(issue => issue.kind !== 'unsupported');
    if (conflicts && !this.planReplace) throw new Error('Replace Figma edits for this plan before applying it.');
    if (this.planAuto && unresolved) throw new Error('Resolve conflicts and removed resources before enabling automatic sync.');
    if (conflicts) {
      const choice = await this.vscode.window.showWarningMessage('This plan replaces Figma edits affecting the planned changes. Continue?', { modal: true }, 'Replace and apply');
      if (choice !== 'Replace and apply') return;
    }
    if (this.plan !== plan || this.planOwner !== this.getRuntime() || this.planAuto !== enableAuto || this.planReplace !== replace) throw new Error('The review changed. Review the plan again.');
    const result = await this.api('/api/project/apply', 'POST', { planId: plan.id, enableAuto, overwriteConflicts: conflicts }, this.planOwner);
    this.plan = null; this.planAuto = false; this.planReplace = false;
    await this.refresh({ resources: true });
    void this.vscode.window.showInformationMessage(`${result.synced} ${result.synced === 1 ? 'resource' : 'resources'} synced${result.issues?.length ? '; some items still need attention' : ''}.`);
  }
  cancelPlan() {
    this.plan = null; this.planAuto = false; this.planReplace = false; this.events.fire();
  }
  toggleReplace() {
    if (!this.plan) return;
    this.planReplace = !this.planReplace; this.events.fire();
  }
  toggleEnableAuto() {
    if (!this.plan || this.snapshot?.project?.mode === 'automatic') return;
    if (this.plan.issues?.some(issue => issue.kind !== 'unsupported')) throw new Error('Resolve conflicts and removed resources before enabling automatic sync.');
    this.planAuto = !this.planAuto; this.events.fire();
  }
  async report() {
    const report = await this.api('/api/report');
    await this.text(report.markdown, 'markdown');
  }
  async text(content, language = 'json', title = 'Elf details') {
    const key = createHash('sha256').update(`${this.getRuntime()?.root}\n${language}\n${content}`).digest('hex');
    const uri = this.vscode.Uri.parse(`elf-readonly:/${encodeURIComponent(title)}.${language === 'markdown' ? 'md' : 'json'}?id=${key}`);
    this.documents.set(uri.toString(), content);
    const document = await this.vscode.workspace.openTextDocument(uri);
    await this.vscode.window.showTextDocument(document, { preview: false }); return document;
  }
  async driftChildren(label) {
    const report = await this.api('/api/report');
    const section = reportSection(report.markdown, label);
    if (!section) return [row('This section changed. Refresh drift details.', 'elf.refresh', null, 'refresh')];
    return [row(`View ${label.toLowerCase()}`, 'elf.driftDetail', null, 'file-text', { title: label }),
      ...section.items.map(item => row(item.name, 'elf.driftDetail', item.summary, 'diff', { title: label, name: item.name, content: item.content }))];
  }
  async driftDetail(detail) {
    if (!detail || typeof detail.title !== 'string') return;
    let content = detail.content;
    if (typeof content !== 'string') {
      const report = await this.api('/api/report');
      content = reportSection(report.markdown, detail.title)?.content;
    }
    if (!content) throw new Error('This drift item is no longer in the report. Refresh the check.');
    await this.text(content, 'markdown', detail.name || detail.title);
  }
  draftDirectory() {
    const base = this.context.storageUri || this.context.globalStorageUri;
    return base ? this.vscode.Uri.joinPath(base, 'description-drafts') : this.vscode.Uri.file(join(tmpdir(), 'elf-extension-drafts'));
  }
  async prepareDescription(component, useAI = false, recoveredContent) {
    if (typeof component !== 'string') {
      const { components } = await this.api('/api/project/components', 'POST', {});
      if (!components?.length) throw new Error('No components discovered. Add a component source file first.');
      const choice = await this.vscode.window.showQuickPick(components.map(item => ({ label: item.name, description: item.file, component: item.codeKey })), { title: useAI ? 'Generate a component description' : 'Prepare a component description', matchOnDescription: true });
      component = choice?.component;
    }
    if (!component) return;
    const owner = await this.ensureRuntime();
    const prepared = await this.api('/api/project/prepare-component', 'POST', { component });
    if (owner !== this.getRuntime()) throw new Error('The project changed. Prepare the description again.');
    const original = JSON.stringify(prepared.sidecar, null, 2);
    if (typeof recoveredContent === 'string') {
      let description; try {description=JSON.parse(recoveredContent);} catch {throw new Error('The recovered draft is not valid JSON.');}
      await this.api('/api/project/validate-description','POST',{component:prepared.codeKey,reviewHash:prepared.reviewHash,description},owner);
      prepared.sidecar=description;
    }
    let generated;
    if (useAI) {
      await this.text(JSON.stringify({ component: prepared.name, file: prepared.file, source: prepared.source, sourceTruncated: prepared.sourceTruncated, tokens: prepared.tokens, variants: prepared.variantProps, dependencies: prepared.dependencies, description: prepared.sidecar }, null, 2), 'json', `${prepared.name} context to share`);
      generated = await generateDescription(this.vscode, prepared);
      if (!generated) return;
      if (owner !== this.getRuntime() || !this.vscode.workspace.isTrusted) throw new Error('The project or workspace trust changed. Prepare again.');
      await this.api('/api/project/validate-description', 'POST', { component: prepared.codeKey, reviewHash: prepared.reviewHash, description: generated.description }, owner);
      prepared.sidecar = generated.description;
      await this.text(JSON.stringify({ assumptions: generated.assumptions, unsupported: generated.unsupported, warning: prepared.warning }, null, 2), 'json', `${prepared.name} AI review notes`);
    }
    const directory = this.draftDirectory();
    await this.vscode.workspace.fs.createDirectory(directory);
    const safe = String(prepared.codeKey || prepared.name).replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80);
    const id = randomUUID();
    const before = this.vscode.Uri.joinPath(directory, `${safe}-${id}.before.json`);
    const draft = this.vscode.Uri.joinPath(directory, `${safe}-${id}.draft.json`);
    const existing = prepared.existing ? `${original}\n` : '{}\n';
    await this.vscode.workspace.fs.writeFile(before, Buffer.from(existing));
    await this.vscode.workspace.fs.writeFile(draft, Buffer.from(`${JSON.stringify(prepared.sidecar, null, 2)}\n`));
    this.drafts.set(draft.toString(), { owner, prepared, generated, uri: draft, before });
    await this.vscode.commands.executeCommand('vscode.diff', before, draft, `Review ${prepared.name} description`, { preview: false });
    this.events.fire();
    if (prepared.warning) void this.vscode.window.showWarningMessage(prepared.warning);
    void this.vscode.window.showInformationMessage(useAI ? 'AI draft validated. Review its assumptions and unsupported details, edit the right side, then use Save Reviewed Description. Nothing has been saved to the project or Figma.' : 'Review the manual draft against the component source and tokens. Use Description Context for reference, then Save Reviewed Description.');
  }
  async descriptionContext() {
    const active = this.vscode.window.activeTextEditor?.document;
    const draft = active && this.drafts.get(active.uri.toString()) || (this.drafts.size === 1 ? [...this.drafts.values()][0] : null);
    if (!draft) throw new Error('Select a component description draft first.');
    await this.text(JSON.stringify({ file: draft.prepared.file, source: draft.prepared.source, sourceTruncated: draft.prepared.sourceTruncated, tokens: draft.prepared.tokens, variants: draft.prepared.variantProps, dependencies: draft.prepared.dependencies, reviewNotes: draft.generated ? { assumptions: draft.generated.assumptions, unsupported: draft.generated.unsupported } : undefined }, null, 2), 'json', `${draft.prepared.name} source and tokens`);
  }
  async recoverDescription() {
    const document=this.vscode.window.activeTextEditor?.document;
    const directory=this.draftDirectory().fsPath;
    if (!document || document.uri.scheme !== 'file' || require('node:path').dirname(document.uri.fsPath) !== directory || !document.uri.fsPath.endsWith('.draft.json')) throw new Error('Select the right-hand Elf description draft to recover.');
    const content=document.getText();
    if (Buffer.byteLength(content)>128000) throw new Error('Draft is too large.');
    await this.prepareDescription(undefined,false,content);
    void this.vscode.window.showInformationMessage('Draft recovered against the current source revision. Review it again before saving; previous approval and AI notes were not restored.');
  }
  async saveDescription(uri, review = false) {
    const visible = this.vscode.window.visibleTextEditors || [];
    const active = this.vscode.window.activeTextEditor;
    const candidates = visible.filter(candidate => this.drafts.has(candidate.document.uri.toString()));
    const requested = typeof uri === 'string' ? this.drafts.get(uri) : null;
    const editor = requested ? {document:await this.vscode.workspace.openTextDocument(requested.uri)} : active && this.drafts.has(active.document.uri.toString()) ? active : candidates.length === 1 ? candidates[0] : null;
    const document = editor?.document;
    const draft = document && this.drafts.get(document.uri.toString());
    if (!draft || draft.owner !== this.getRuntime()) throw new Error('Open a description using Elf: Prepare Component Description first.');
    const source = document.getText(); let description;
    try { description = JSON.parse(source); } catch { throw new Error('Fix the description JSON before saving.'); }
    if (await this.vscode.window.showWarningMessage(`Save this reviewed description for ${draft.prepared.name}? This pauses automatic sync and does not write to Figma.`, { modal: true }, 'Save reviewed description') !== 'Save reviewed description') return;
    if (document.getText() !== source || draft.owner !== this.getRuntime()) throw new Error('The draft or project changed. Review it again.');
    await this.api('/api/project/save-description', 'POST', { component: draft.prepared.codeKey, reviewHash: draft.prepared.reviewHash, description }, draft.owner);
    this.drafts.delete(document.uri.toString());
    try { await this.vscode.workspace.fs.delete(draft.uri, { useTrash: false }); } catch {}
    if (draft.before) { try { await this.vscode.workspace.fs.delete(draft.before, { useTrash: false }); } catch {} }
    this.plan = null; this.planAuto = false; this.planReplace = false;
    await this.refresh({ resources: true });
    if (review) await this.reviewSync(false, {kind:'component',key:draft.prepared.codeKey});
    else {const next = await this.vscode.window.showInformationMessage('Reviewed description saved.', 'Review component sync'); if (next === 'Review component sync') await this.reviewSync(false,{kind:'component',key:draft.prepared.codeKey});}
  }
  async openResource(resource) {
    if (!resource || !publicLink(resource.figmaUrl)) throw new Error('Invalid Figma resource link.');
    await this.vscode.env.openExternal(this.vscode.Uri.parse(resource.figmaUrl));
  }
  async assistants() {
    if (!this.snapshot) await this.refresh();
    const integration = this.snapshot?.project?.integration;
    if (!integration) throw new Error('Coding assistant setup is unavailable until project setup completes.');
    const choice = await this.vscode.window.showQuickPick([
      { label: 'Cursor', value: 'cursor' },
      { label: 'Claude Code', value: 'claude' },
      { label: 'Codex', value: 'codex' },
    ], { title: 'Connect a coding assistant', placeHolder: 'Choose where to add the Elf MCP server' });
    if (!choice) return;
    const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
    const command = [integration.command, ...integration.args].map(quote).join(' ');
    const snippet = choice.value === 'cursor'
      ? JSON.stringify({ mcpServers: { elf: { type: 'stdio', command: integration.command, args: integration.args } } }, null, 2)
      : choice.value === 'claude' ? `claude mcp add --transport stdio --scope local elf -- ${command}` : `codex mcp add elf -- ${command}`;
    await this.text(snippet, choice.value === 'cursor' ? 'json' : 'shellscript');
    const copy = await this.vscode.window.showInformationMessage(`Add this Elf MCP configuration for ${choice.label}. Keep the Figma plugin open.`, 'Copy snippet');
    if (copy === 'Copy snippet' && this.vscode.env.clipboard) await this.vscode.env.clipboard.writeText(snippet);
  }
  notificationKey() { return `elf.notifications:${this.getRuntime()?.root || ''}`; }
  notificationState() {
    const state = this.context.workspaceState?.get(this.notificationKey(), { read: [], cleared: [] }) || {};
    return { read: Array.isArray(state.read) ? state.read : [], cleared: Array.isArray(state.cleared) ? state.cleared : [] };
  }
  unreadCount() {
    const prefs = this.notificationState();
    return compactActivity(this.snapshot?.project?.activity || []).filter(item => !prefs.cleared.includes(item.id) && !prefs.read.includes(item.id)).length;
  }
  async notifications() {
    const choice = await this.vscode.window.showQuickPick(['Mark all as read', 'Clear all'], { title: 'Elf notifications' });
    if (!choice) return;
    const ids = (this.snapshot?.project?.activity || []).map(item => item.id);
    const prefs = this.notificationState();
    await this.context.workspaceState.update(this.notificationKey(), {
      read: [...new Set([...prefs.read, ...ids])].slice(-500),
      cleared: choice === 'Clear all' ? [...new Set([...prefs.cleared, ...ids])].slice(-500) : prefs.cleared,
    });
    void this.vscode.commands.executeCommand('setContext', 'elf.hasPlan', Boolean(this.plan));
    this.events.fire();
  }
  async openActivity(item) {
    if (!item || typeof item.message !== 'string') return;
    await this.text(JSON.stringify({ at: item.at, type: item.type, message: item.message, changes: item.changes }, null, 2));
    const prefs = this.notificationState();
    await this.context.workspaceState.update(this.notificationKey(), { ...prefs, read: [...new Set([...prefs.read, item.id])].slice(-500) });
    void this.vscode.commands.executeCommand('setContext', 'elf.hasPlan', Boolean(this.plan));
    this.events.fire();
  }
}

module.exports = { NativeElf, row };
