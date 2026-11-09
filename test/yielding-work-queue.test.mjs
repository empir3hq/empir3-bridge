import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createYieldingWorkQueue } = require('../src/yielding-work-queue.js');

test('large queued hydration yields to account and heartbeat work', async () => {
  const queue = createYieldingWorkQueue({ concurrency: 4 });
  const tasks = Array.from({ length: 250 }, (_, index) => queue.enqueue(() => index));
  let accountControlRan = false;
  await new Promise((resolve) => setTimeout(() => {
    accountControlRan = true;
    resolve();
  }, 0));
  assert.equal(accountControlRan, true);
  assert.ok(queue.status().pending > 0, 'the queue should yield before draining the full hydration batch');
  assert.deepEqual(await Promise.all(tasks), Array.from({ length: 250 }, (_, index) => index));
  assert.deepEqual(queue.status(), { active: 0, pending: 0, concurrency: 4 });
});

test('hydration concurrency is bounded', async () => {
  const queue = createYieldingWorkQueue({ concurrency: 3 });
  let active = 0;
  let maxActive = 0;
  const tasks = Array.from({ length: 20 }, () => queue.enqueue(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
  }));
  await Promise.all(tasks);
  assert.equal(maxActive, 3);
});

test('invalid queue concurrency is rejected', () => {
  assert.throws(() => createYieldingWorkQueue({ concurrency: 0 }), /between 1 and 64/);
  assert.throws(() => createYieldingWorkQueue({ concurrency: 65 }), /between 1 and 64/);
});
