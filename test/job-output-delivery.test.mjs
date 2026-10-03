import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import sourceModule from '../src/job-output-delivery.ts';
import limits from '../src/sync-limits.js';
const { jobOutputPayload, JobOutputDelivery } = sourceModule;
const file = { projectId: 'project-a', projectName: 'A', relPath: 'out/archive.pst', mtimeMs: 42 };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('unknown-extension, no-extension and UTF-8 job outputs survive the real JSON/base64 wire representation', () => {
  const binary = Buffer.alloc(2_000_000);
  for (let i=0; i<binary.length; i++) binary[i] = i % 256;
  for (const path of ['archive.pst', 'unknown.dat', 'part-001', 'fake.txt']) {
    const payload = JSON.parse(JSON.stringify(jobOutputPayload({ ...file, relPath: path }, binary)));
    const received = Buffer.from(payload.content, payload.encoding);
    assert.deepEqual(received, binary);
    assert.equal(received.length, payload.sizeBytes);
    assert.equal(hash(received), payload.sha256);
    assert.equal(payload.hash, hash(binary));
  }
  const utf8 = Buffer.from('café 日本語\r\n$unchanged\u0000');
  const payload = jobOutputPayload(file, utf8);
  assert.deepEqual(Buffer.from(payload.content, payload.encoding), utf8);
});

test('the largest accepted binary fits a complete frame, and oversize is refused before send', () => {
  const payload = jobOutputPayload(file, Buffer.alloc(limits.MAX_SYNC_FILE_BYTES, 255));
  assert.ok(Buffer.byteLength(JSON.stringify({ type: 'desktop:sync:local:file', payload })) < limits.SYNC_SERVER_FRAME_CAP);
  assert.throws(() => jobOutputPayload(file, Buffer.alloc(limits.MAX_SYNC_FILE_BYTES + 1)), /No bytes were sent/);
  assert.throws(() => jobOutputPayload({ ...file, projectName: 'x'.repeat(limits.SYNC_SERVER_FRAME_CAP) }, Buffer.alloc(1)), /metadata.*frame limit/);
});

test('socket send alone never proves delivery; no matching ack yields an explicit uncertain result', async () => {
  const delivery = new JobOutputDelivery();
  const result = await delivery.deliver(jobOutputPayload(file, Buffer.from('abc')), async () => true, 15);
  assert.equal(result.accepted, false);
  assert.match(result.reason, /not confirmed.*may have arrived/);
});

test('wrong project, path or original hash cannot acknowledge a file', async () => {
  const delivery = new JobOutputDelivery(), payload = jobOutputPayload(file, Buffer.from([0,255,128]));
  const result = delivery.deliver(payload, async () => true, 100);
  for (const altered of [{projectId:'other'}, {path:'other'}, {hash:'0'.repeat(64)}]) {
    delivery.acknowledge({...payload, ...altered, accepted:true});
  }
  let settled = false; result.then(() => { settled = true; });
  await new Promise(r => setTimeout(r, 5)); assert.equal(settled, false);
  delivery.acknowledge({...payload, accepted:true});
  assert.deepEqual(await result, { accepted:true });
});

test('conflict copy and offline transport are failures, not delivered files', async () => {
  const delivery = new JobOutputDelivery(), payload = jobOutputPayload(file, Buffer.from('x'));
  const pending = delivery.deliver(payload, async () => true, 100);
  delivery.acknowledge({...payload, accepted:false, result:'conflict-copy'});
  assert.match((await pending).reason, /conflict copy/);
  const offline = await delivery.deliver(payload, async () => false, 100);
  assert.equal(offline.accepted, false); assert.match(offline.reason, /could not send/);
});

test('hung or late socket callbacks cannot outlive the deadline or erase a later receipt waiter', async () => {
  const delivery = new JobOutputDelivery(), payload = jobOutputPayload(file, Buffer.from('x'));
  let release;
  const first = delivery.deliver(payload, () => new Promise(r => {release=r;}), 10);
  assert.equal((await first).accepted, false);
  const second = delivery.deliver(payload, async () => true, 100);
  release(false);
  await new Promise(r => setTimeout(r, 5));
  delivery.acknowledge({...payload, accepted:true});
  assert.deepEqual(await second, {accepted:true});
});
