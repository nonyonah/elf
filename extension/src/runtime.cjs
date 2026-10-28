const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { createRequire } = require('node:module');

// Read only known protocol lines; never forward runtime output to editor logs.
function settingsLink(line) {
  const match = /Settings: (http:\/\/127\.0\.0\.1:\d+\/#elf=[a-f0-9]+)(?:\s|$)/.exec(line);
  if (!match) return null;
  try {
    const url = new URL(match[1]);
    return Number(url.port) > 0 && Number(url.port) <= 65535 ? url.href : null;
  } catch { return null; }
}

class Runtime {
  constructor(root, changed, launch = spawn, packageRoot = join(__dirname, '../runtime/node_modules/elf-tokens')) {
    this.root = root;
    this.changed = changed;
    this.launch = launch;
    this.packageRoot = packageRoot;
    this.state = 'stopped';
    this.link = null;
    this.pairing = null;
    this.child = null;
    this.requestId = 0;
    this.session = null;
    this.sessionOpening = null;
  }
  start() {
    if (this.child) return;
    const entry = join(this.packageRoot, 'src/start.ts');
    if (!existsSync(entry)) throw new Error('Elf runtime is missing. Prepare the extension runtime before launching it.');
    const runtimeRequire = createRequire(join(this.packageRoot, 'package.json'));
    const loader = runtimeRequire.resolve('tsx');
    // Fixed extension-owned entry and loader. No shell or workspace executable.
    const child = this.launch(process.execPath, ['--import', loader, '--input-type=module', '--eval',
      'const { main } = await import(process.argv[1]); process.exitCode = await main(process.argv.slice(2));',
      require('node:url').pathToFileURL(entry).href, '--no-open', '--settings-port', '0', '--config', join(this.root, 'elf.config.json')],
      { cwd: this.root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '', NODE_PATH: '', ELF_SETTINGS_NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    this.child = child;
    this.state = 'starting';
    this.changed();
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop().slice(-8192);
      for (const line of lines) {
        const link = settingsLink(line);
        if (link) { this.link = link; this.state = 'running'; }
        const pairing = /^(?:New p|P)airing code: ([A-Za-z0-9-]{4,64})$/.exec(line);
        if (pairing) this.pairing = { code: pairing[1], expires: Date.now() + 5 * 60_000 };
      }
      this.changed();
    });
    // Consume stderr without persisting private links, tokens, or file content.
    child.stderr.on('data', () => {});
    const finish = state => {
      if (this.child !== child) return;
      this.child = null; this.link = null; this.pairing = null; this.session = null; this.state = state;
      this.changed();
    };
    child.once('error', () => finish('failed'));
    child.once('exit', code => finish(this.state === 'stopping' || code === 0 ? 'stopped' : 'failed'));
  }
  async openSettings() {
    const child = this.child;
    if (!child || this.state !== 'running') throw new Error('Start Elf before opening Settings.');
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); };
      const fail = () => { cleanup(); reject(new Error('Could not open Elf Settings. Restart Elf and retry.')); };
      const onExit = () => fail();
      const onMessage = message => {
        if (message?.type !== 'elf:settings' || message.id !== id) return;
        const link = typeof message.url === 'string' ? settingsLink(`Settings: ${message.url}`) : null;
        if (!link || new URL(link).origin !== new URL(this.link).origin) { fail(); return; }
        cleanup(); resolve(link);
      };
      const timer = setTimeout(fail, 5000);
      child.on('message', onMessage); child.once('exit', onExit);
      try { child.send({ type: 'elf:open-settings', id }, error => { if (error) fail(); }); } catch { fail(); }
    });
  }
  async request(path, method = 'GET', body) {
    if (!require('./api-policy.cjs').allowedRequest(path, method, body)) throw new Error('Settings request is not allowed.');
    if (!this.child || this.state !== 'running') throw new Error('Elf is not running.');
    const child = this.child;
    if (!this.session) {
      if (!this.sessionOpening) this.sessionOpening = (async () => {
        const link = new URL(await this.openSettings());
        const response = await fetch(`${link.origin}/api/session`, { method: 'POST', headers: {
          'X-Elf-Request': '1', 'X-Elf-Bootstrap': new URLSearchParams(link.hash.slice(1)).get('elf'),
        }, redirect: 'error', signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error('Cannot authenticate Elf Settings.');
        const { session } = await response.json();
        if (this.child !== child || !/^[a-f0-9]{64}$/.test(session)) throw new Error('Elf session changed.');
        this.session = session;
      })().finally(() => { this.sessionOpening = null; });
      await this.sessionOpening;
    }
    const response = await fetch(new URL(path, new URL(this.link).origin), {
      method, ...(body != null ? { body } : {}), redirect: 'error', signal: AbortSignal.timeout(120000),
      headers: { 'X-Elf-Session': this.session, 'X-Elf-Request': '1', 'Content-Type': 'application/json' },
    });
    if (response.status === 401) this.session = null;
    return { status: response.status, contentType: response.headers.get('content-type') || 'application/json', body: await response.text() };
  }
  async stop() {
    const child = this.child;
    if (!child) return;
    this.state = 'stopping'; this.link = null; this.pairing = null; this.changed();
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 8000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }
  async restartBridge() {
    await this.stop();
    const loader = createRequire(join(this.packageRoot, 'package.json')).resolve('tsx');
    const entry = require('node:url').pathToFileURL(join(this.packageRoot, 'watch/src/bridge-host.ts')).href;
    await new Promise((resolve, reject) => {
      let output = '';
      const child = this.launch(process.execPath, ['--import',loader,'--input-type=module','--eval','const {main}=await import(process.argv[1]); process.exitCode=await main(["--stop"]);',entry], {cwd:this.root,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',NODE_OPTIONS:'',NODE_PATH:''},stdio:['ignore','pipe','pipe']});
      const collect = chunk => {output=(output+chunk.toString()).slice(-8192);};
      child.stdout.on('data',collect); child.stderr.on('data',collect);
      const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('Bridge restart timed out. Stop other Elf clients and retry.'));},10000);
      child.once('error',()=>{clearTimeout(timer);reject(new Error('Could not restart the shared bridge.'));});
      child.once('exit',code=>{clearTimeout(timer);if(code===0 || output.includes('Cannot reach the Elf bridge')) resolve();else reject(new Error('Another Elf client may still be using the bridge. Stop Elf MCP/watch sessions and retry.'));});
    });
    this.start();
  }
}
module.exports = { Runtime, settingsLink };
