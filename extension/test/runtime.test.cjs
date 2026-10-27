const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { resolve } = require('node:path');
const { Runtime, settingsLink } = require('../src/runtime.cjs');

test('only protocol links to loopback Settings with a bootstrap are accepted', () => {
  assert.equal(settingsLink('Settings: http://127.0.0.1:3210/#elf=abcdef'), 'http://127.0.0.1:3210/#elf=abcdef');
  for (const line of ['Settings: https://attacker.test/#elf=abc', 'Settings: http://127.0.0.1:99999/#elf=abc',
    'Settings: http://127.0.0.1:1234/#elf=abc&redirect=evil', 'Settings: http://127.0.0.1:3210/']) {
    assert.equal(settingsLink(line), null);
  }
});

function harness() {
  let invocation;
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = signal => { queueMicrotask(() => child.emit('exit', null, signal)); };
  const runtime = new Runtime('/tmp/project with spaces', () => {}, (...args) => { invocation = args; return child; }, resolve(__dirname, '../..'));
  return { runtime, child, invocation: () => invocation };
}

test('launch uses extension-owned code without shell execution; split output stays private', async () => {
  const h = harness(); h.runtime.start();
  const [executable, args, options] = h.invocation();
  assert.equal(executable, process.execPath);
  assert.equal(options.shell, undefined);
  assert.equal(options.cwd, '/tmp/project with spaces');
  assert.equal(options.env.NODE_OPTIONS, '');
  assert.equal(args.at(-1), '/tmp/project with spaces/elf.config.json');
  assert.equal(h.runtime.state, 'starting');
  h.child.stdout.emit('data', Buffer.from('Pairing code: ABCD-1234\nSettings: http://127.0.'));
  assert.equal(h.runtime.link, null);
  h.child.stdout.emit('data', Buffer.from('0.1:3210/#elf=abcdef\n'));
  assert.equal(h.runtime.state, 'running'); assert.equal(h.runtime.pairing.code, 'ABCD-1234');
  h.runtime.start(); // repeated starts do not create a second child
  await h.runtime.stop();
  assert.equal(h.runtime.state, 'stopped'); assert.equal(h.runtime.link, null); assert.equal(h.runtime.pairing, null);
});

test('unexpected exit clears credentials and reports failure', () => {
  const h = harness(); h.runtime.start();
  h.child.stdout.emit('data', Buffer.from('Settings: http://127.0.0.1:3210/#elf=abcdef\n'));
  h.child.emit('exit', 1);
  assert.equal(h.runtime.state, 'failed'); assert.equal(h.runtime.link, null); assert.equal(h.runtime.child, null);
});

test('missing bundled runtime fails before spawning any executable', () => {
  let spawned = false;
  const runtime = new Runtime('/tmp', () => {}, () => { spawned = true; }, '/missing/elf-runtime');
  assert.throws(() => runtime.start(), /runtime is missing/); assert.equal(spawned, false);
});

test('each Settings open requests a fresh private link and rejects a changed origin', async () => {
  const h = harness(); h.runtime.start();
  h.child.stdout.emit('data', Buffer.from('Settings: http://127.0.0.1:3210/#elf=abcdef\n'));
  let requests = 0;
  h.child.send = request => { requests++; queueMicrotask(() => h.child.emit('message', {
    type: 'elf:settings', id: request.id, url: `http://127.0.0.1:3210/#elf=${requests === 1 ? 'aa' : 'bb'}`,
  })); };
  assert.notEqual(await h.runtime.openSettings(), await h.runtime.openSettings());
  h.child.send = request => queueMicrotask(() => h.child.emit('message', {
    type: 'elf:settings', id: request.id, url: 'http://127.0.0.1:9999/#elf=abc',
  }));
  await assert.rejects(h.runtime.openSettings(), /Could not open/);
  await h.runtime.stop();
});
