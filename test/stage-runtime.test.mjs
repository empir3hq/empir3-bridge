import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { bridgeRoot, stageBridgeRuntime } = require('../scripts/stage-bridge-runtime.cjs');

test('shared runtime stager refuses every output outside its two disposable package roots', () => {
  assert.throws(() => stageBridgeRuntime({ runtimeRoot: bridgeRoot }), /unsafe runtime staging path/);
  assert.throws(() => stageBridgeRuntime({ runtimeRoot: `${bridgeRoot}/src` }), /unsafe runtime staging path/);
  assert.throws(() => stageBridgeRuntime({ runtimeRoot: `${bridgeRoot}/desktop-shell` }), /unsafe runtime staging path/);
});
