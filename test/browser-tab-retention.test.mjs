import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserTabRetention, MAX_BROWSER_TABS } from '../src/browser-tab-retention.js';

test('70 queued opens are bounded; opening and ending calls never delete user or earlier work tabs', async () => {
  const retention = createBrowserTabRetention();
  const pages = [{ id: 'user' }, { id: 'previous-task' }];
  let active = 0, peak = 0, next = 0;
  const results = await Promise.allSettled(Array.from({ length: 70 }, () => retention.open(
    async () => [...pages], async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      const page = { id: `work-${++next}` }; pages.push(page); active--;
      return { targetId: page.id };
    })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, MAX_BROWSER_TABS - 2);
  assert.equal(pages.length, MAX_BROWSER_TABS);
  assert.equal(peak, 1, 'CDP create/attach/navigation must not race');
  assert.deepEqual(pages.slice(0, 2), [{ id: 'user' }, { id: 'previous-task' }]);
  for (const r of results) {
    if (r.status === 'fulfilled') assert.equal(r.value.tabPolicy.mode, 'keep-until-explicit-close');
    else assert.match(r.reason.message, /browser_tab_limit.*No tabs were closed/);
  }
});

test('restored tabs count after restart; explicit close releases a slot', async () => {
  const pages = Array.from({ length: MAX_BROWSER_TABS }, (_, id) => ({ id }));
  const retention = createBrowserTabRetention();
  let creates = 0;
  const open = () => retention.open(async () => pages, async () => { creates++; pages.push({ id: 'new' }); return { targetId: 'new' }; });
  await assert.rejects(open(), /browser_tab_limit/);
  assert.equal(creates, 0);
  pages.pop();
  assert.equal((await open()).targetId, 'new');
  assert.equal(pages.length, MAX_BROWSER_TABS);
});

test('unreadable inventory and failed navigation do not poison the creation queue', async () => {
  const retention = createBrowserTabRetention();
  let created = false;
  await assert.rejects(retention.open(async () => { throw Error('CDP unavailable'); }, async () => { created = true; }), /CDP unavailable/);
  assert.equal(created, false);
  await assert.rejects(retention.open(async () => [], async () => { throw Error('navigation failed'); }), /navigation failed/);
  assert.equal((await retention.open(async () => [], async () => ({ targetId: 'retry' }))).targetId, 'retry');
});
