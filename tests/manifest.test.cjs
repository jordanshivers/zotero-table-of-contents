const { test } = require('node:test');
const assert = require('node:assert/strict');
const manifest = require('../src/manifest.json');

test('manifest includes fields required by the Zotero 10 add-on loader', () => {
  assert.equal(manifest.manifest_version, 2);
  assert.ok(manifest.name);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  const app = manifest.applications?.zotero;
  // Required by Zotero.
  for (const field of ['id', 'update_url', 'strict_max_version']) {
    assert.ok(app?.[field], `Missing applications.zotero.${field}`);
  }
  assert.equal(app.strict_min_version, '10.0');
  assert.equal(app.strict_max_version, '10.0.*');
  const url = new URL(app.update_url);
  // Zotero rejects non-HTTPS update URLs.
  assert.equal(url.protocol, 'https:');
  assert.ok(url.hostname);
});
