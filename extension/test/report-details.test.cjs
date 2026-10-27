const assert = require('node:assert/strict');
const { test } = require('node:test');
const { reportSection, compactActivity } = require('../src/report-details.cjs');

test('a selected drift contains only its own values, including escaped table cells', () => {
  const report = '### Value mismatches\n\n| Token | Category | Figma | Code |\n|---|---|---|---|\n| `color/brand` | color | `#fff` | `#000` |\n| `font\\|name` | string | `A` | `B` |\n\n### Missing in code\n\n| Token | Category | Value |\n|---|---|---|\n| `other` | color | `#ddd` |';
  const section = reportSection(report, 'Value mismatches');
  assert.equal(section.items.length, 2);
  assert.equal(section.items[1].name, 'font|name');
  assert.match(section.items[0].content, /#fff/);
  assert.equal(section.items[0].content.includes('font'), false);
  assert.equal(section.content.includes('Missing in code'), false);
});

test('unchanged repeated checks collapse but changed fingerprints and other activity remain', () => {
  const items = [{ type: 'check', message: '143 drift items', fingerprint: 'new' }, { type: 'check', message: '143 drift items', fingerprint: 'new' }, { type: 'sync', message: 'Button synced' }, { type: 'check', message: '143 drift items', fingerprint: 'old' }];
  assert.deepEqual(compactActivity(items), [items[0], items[2], items[3]]);
});
