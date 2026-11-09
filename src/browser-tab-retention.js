'use strict';

// There is no task-end signal in the browser wire contract. Keep work visible
// until explicitly closed; never infer that opening a new tab ends old work.
// The budget counts every live page (including restored/user pages) so a
// daemon restart cannot reset it. Reaching it refuses creation, not retention.
const MAX_BROWSER_TABS = 24;
function createBrowserTabRetention() {
  let queue = Promise.resolve();
  function policy() {
    return { mode: 'keep-until-explicit-close', maxOpenTabs: MAX_BROWSER_TABS,
      message: 'Tabs stay open until explicitly closed. Close finished work tabs before opening more; opening a new tab never closes another tab.' };
  }
  function open(listPages, create) {
    // Creating + attaching + navigating changes the shared CDP connection.
    // Serialize the whole operation, including the inventory/budget check.
    const run = queue.then(async () => {
      const pages = await listPages();
      if (!Array.isArray(pages)) throw new Error('Could not read the live browser tab inventory. No tab was opened.');
      if (pages.length >= MAX_BROWSER_TABS) {
        throw new Error(`browser_tab_limit: ${pages.length} tabs are open (limit ${MAX_BROWSER_TABS}). No tabs were closed. Close finished agent-owned tabs explicitly, then retry.`);
      }
      return { ...await create(), tabPolicy: policy() };
    });
    queue = run.catch(() => {});
    return run;
  }
  return { open, policy };
}
module.exports = { createBrowserTabRetention, MAX_BROWSER_TABS };
