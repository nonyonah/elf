import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const extension = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(extension, '..');
const scratch = mkdtempSync(join(tmpdir(), 'elf-extension-package-'));
try {
  execFileSync('npm', ['--prefix', join(root, 'settings-next'), 'run', 'build'], { stdio: 'inherit' });
  execFileSync('npm', ['run', 'build:bridge-plugin'], { cwd: root, stdio: 'inherit' });
  // Build from this checkout at packaging time, never install workspace code at runtime.
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], { cwd: root, encoding: 'utf8' }));
  const runtime = join(extension, 'runtime');
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, 'package.json'), JSON.stringify({ private: true, name: 'elf-extension-runtime', version: '0.0.0' }));
  execFileSync('npm', ['install', '--prefix', runtime, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', join(scratch, pack.filename)], { stdio: 'inherit' });
} finally { rmSync(scratch, { recursive: true, force: true }); }
