import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordActivity, readActivity } from '../src/activity.js';

test('activity suppresses unchanged checks but records same-count drift with a new fingerprint', () => {
  const root = mkdtempSync(join(tmpdir(), 'elf-activity-'));
  const config = join(root, 'elf.config.json');
  try {
    writeFileSync(join(root, 'drift-status.json'), JSON.stringify({ fingerprint: 'a'.repeat(16) }));
    recordActivity(config, 'check', '143 drift items remain.');
    recordActivity(config, 'check', '143 drift items remain.');
    recordActivity(config, 'check', '143 drift items remain. See drift-report.md.');
    assert.equal(readActivity(config).length, 1);
    writeFileSync(join(root, 'drift-status.json'), JSON.stringify({ fingerprint: 'b'.repeat(16) }));
    recordActivity(config, 'check', '143 drift items remain.');
    assert.equal(readActivity(config).length, 2);
    assert.equal(readActivity(config)[0]?.fingerprint, 'b'.repeat(16));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
