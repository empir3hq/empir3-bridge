'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { validateInstallConfig } = require('../src/install-config.cjs');

test('accepts supported root-owned locations and production or loopback servers', () => {
  assert.deepEqual(validateInstallConfig({
    prefix: '/opt/empir3-bridge', serviceUser: 'empir3', server: 'https://app.empir3.com',
  }), {
    prefix: '/opt/empir3-bridge', serviceUser: 'empir3', server: 'https://app.empir3.com',
  });
  assert.equal(validateInstallConfig({
    prefix: '/usr/local/lib/empir3/bridge', serviceUser: 'bridge_1', server: 'http://127.0.0.1:3005',
  }).server, 'http://127.0.0.1:3005');
});

test('refuses traversal, unsafe users, remote cleartext, and JSON injection characters', () => {
  const good = { prefix: '/opt/empir3-bridge', serviceUser: 'empir3', server: 'https://app.empir3.com' };
  assert.throws(() => validateInstallConfig({ ...good, prefix: '/opt/../etc' }), /prefix is unsafe/);
  assert.throws(() => validateInstallConfig({ ...good, prefix: '/tmp/bridge' }), /prefix is unsafe/);
  assert.throws(() => validateInstallConfig({ ...good, serviceUser: 'root;id' }), /user is unsafe/);
  assert.throws(() => validateInstallConfig({ ...good, server: 'http://app.empir3.com' }), /server URL is unsafe/);
  assert.throws(() => validateInstallConfig({ ...good, server: 'https://app.empir3.com\"}' }), /server URL is unsafe/);
});
