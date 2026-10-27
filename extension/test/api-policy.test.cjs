const assert = require('node:assert/strict');
const { test } = require('node:test');
const { allowedRequest, publicLink } = require('../src/api-policy.cjs');

test('native API requests stay on the allowlisted Settings routes', () => {
  assert.equal(allowedRequest('/api/config', 'GET'), true);
  assert.equal(allowedRequest('/api/config', 'PATCH', '{}'), true);
  assert.equal(allowedRequest('/api/project/apply', 'POST', '{}'), true);
  assert.equal(allowedRequest('/api/project/prepare-component', 'POST', '{}'), true);
  for (const path of ['https://evil.test/api/config', '//evil.test/api/config', '/api/session', '/api/identity', '/api/figma/broker-callback', '/api/config?x=1', '/api/../api/config']) {
    assert.equal(allowedRequest(path, 'GET'), false);
  }
  assert.equal(allowedRequest('/api/config', 'DELETE'), false);
  assert.equal(allowedRequest('/api/config', 'PATCH', 'x'.repeat(300000)), false);
});

test('only public Figma design links can open from the native tree', () => {
  for (const value of ['file:///etc/passwd', 'command:workbench.action.closeWindow', 'https://evil.test/', 'https://figma.com.evil.test/', 'https://user:pass@figma.com/']) assert.equal(publicLink(value), false);
  assert.equal(publicLink('https://www.figma.com/design/file'), true);
  assert.equal(publicLink('https://figma.com/design/file?node-id=1%3A2'), true);
});
