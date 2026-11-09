'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, existsSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { isolateMcpProfile } = require('../src/mcp-profile.cjs');

test('concurrent MCP clients use separate profiles and cannot clean the desktop profile', () => {
  const root = mkdtempSync(join(tmpdir(), 'empir3-mcp-profile-test-'));
  const sentinel = join(root, 'desktop-state');
  writeFileSync(sentinel, 'preserve');
  const profiles = [];
  const app = () => ({
    getPath: name => { assert.equal(name, 'temp'); return root; },
    setPath: (name, value) => { assert.ok(existsSync(value)); profiles.push({ name, value }); },
  });
  try {
    const first = isolateMcpProfile(app());
    const second = isolateMcpProfile(app());
    assert.notEqual(profiles[0].value, profiles[2].value);
    assert.equal(profiles[0].value, profiles[1].value);
    assert.equal(profiles[0].name, 'userData');
    assert.equal(profiles[1].name, 'sessionData');
    first(); first();
    assert.equal(existsSync(profiles[0].value), false);
    assert.equal(existsSync(profiles[2].value), true);
    assert.equal(readFileSync(sentinel, 'utf8'), 'preserve');
    second();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
