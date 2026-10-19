'use strict';
const { randomUUID } = require('node:crypto');

// Page dialogs suspend JavaScript. Observe them on a retained CDP session so
// answering one never waits behind the input/evaluation that opened it.
function createBrowserDialogs(openSession) {
  const sessions = new Map();
  async function ensure(targetId) {
    if (sessions.has(targetId)) return sessions.get(targetId);
    const session = await openSession();
    if (session.targetId !== targetId) { session.close(); throw new Error('target_changed: observe the selected tab again.'); }
    const state = { session, dialog: null, closed: null, listeners: new Set() };
    sessions.set(targetId, state);
    session.onEvent(event => {
      if (event.method === 'Page.javascriptDialogOpening') {
        const p = event.params || {};
        state.dialog = { id: randomUUID(), targetId, type: p.type, message: p.message, url: p.url, defaultPrompt: p.defaultPrompt || '' };
        for (const listener of state.listeners) listener(state.dialog);
      } else if (event.method === 'Page.javascriptDialogClosed') {
        state.closed = { id: state.dialog?.id, accepted: event.params?.result === true };
        state.dialog = null;
      } else if (event.method === 'Bridge.sessionClosed') {
        sessions.delete(targetId);
      }
    });
    try { await session.send('Page.enable'); }
    catch (error) { sessions.delete(targetId); session.close(); throw error; }
    // Retain pending dialogs, but bound idle observer resources.
    for (const [id, old] of sessions) {
      if (sessions.size <= 16) break;
      if (id !== targetId && !old.dialog && !old.listeners.size) { sessions.delete(id); old.session.close(); }
    }
    return state;
  }
  function pending(targetId) { return sessions.get(targetId)?.dialog || null; }
  function check(targetId) {
    const dialog = pending(targetId);
    if (dialog) throw new Error(`browser_dialog_pending: ${dialog.type} is waiting. Call browser_dialog action:status for this exact tab, then accept or dismiss its returned dialogId. Do not repeat the previous input.`);
  }
  async function run(targetId, operation) {
    const state = await ensure(targetId); check(targetId);
    let listener;
    const opened = new Promise(resolve => { listener = dialog => resolve({ success: true, dispatched: true, verified: false, needsDialogResponse: true, dialog, next: 'Read this dialog, then use browser_dialog with its id and exact target. Verify the page afterward; do not repeat the triggering input.' }); state.listeners.add(listener); });
    try { return await Promise.race([Promise.resolve().then(operation), opened]); }
    finally { state.listeners.delete(listener); }
  }
  async function handle(targetId, action = 'status', dialogId, promptText) {
    if (!['status', 'accept', 'dismiss'].includes(action)) throw new Error('dialog action must be status, accept or dismiss');
    const state = await ensure(targetId);
    if (action === 'status') return { success: true, targetId, dialog: state.dialog };
    const dialog = state.dialog;
    if (!dialog || !dialogId || dialog.id !== dialogId) throw new Error('stale_dialog: read browser_dialog status and use its current dialog id. No response was sent.');
    if (promptText !== undefined && (action !== 'accept' || dialog.type !== 'prompt')) throw new Error('promptText is only valid when accepting a prompt. No response was sent.');
    await state.session.send('Page.handleJavaScriptDialog', { accept: action === 'accept', ...(promptText !== undefined ? { promptText } : {}) });
    for (let i = 0; i < 50 && state.closed?.id !== dialog.id; i++) await new Promise(r => setTimeout(r, 20));
    const verified = state.closed?.id === dialog.id && state.closed.accepted === (action === 'accept');
    return { success: verified, dispatched: true, verified, dialogId: dialog.id, action, ...(verified ? {} : { error: 'Dialog response was sent, but closure was not verified. Observe status before any further action.' }) };
  }
  return { ensure, pending, check, run, handle };
}
module.exports = { createBrowserDialogs };
