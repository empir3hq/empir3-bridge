import assert from 'node:assert/strict';
import test from 'node:test';
import sourceModule1 from '../src/browser-request-policy.ts';
const {
  localBrowserRequestTimeoutMs,
  shouldRetryLocalBrowserFetch,
  shouldRetryScreenshotCdpFailure,
  shouldRetryCdpCommand,
} = sourceModule1;

test('uncertain input, evaluation, navigation and dialog responses never replay', () => {
  for (const method of ['Input.dispatchMouseEvent','Input.dispatchKeyEvent','Input.insertText','Runtime.evaluate','Page.navigate','Page.handleJavaScriptDialog']) {
    for (const error of ['CDP timeout','WebSocket connection closed','CDP connection reset']) assert.equal(shouldRetryCdpCommand(method,new Error(error)),false,method);
  }
  assert.equal(shouldRetryCdpCommand('Page.getLayoutMetrics',new Error('WebSocket connection closed')),true);
  assert.equal(shouldRetryCdpCommand('Page.getLayoutMetrics',new Error('CDP timeout')),false);
});

test('page reads outwait the CDP command without exceeding the app tool budget', () => {
  assert.equal(localBrowserRequestTimeoutMs('/text'), 12_000);
  assert.equal(localBrowserRequestTimeoutMs('/snapshot'), 12_000);
  assert.equal(localBrowserRequestTimeoutMs('/screenshot', true), 22_000);
  assert.equal(localBrowserRequestTimeoutMs('/health'), 5_000);
});

test('wrapper timeouts do not enqueue duplicate browser reads', () => {
  assert.equal(shouldRetryLocalBrowserFetch({ name: 'AbortError' }, 0), false);
  assert.equal(shouldRetryLocalBrowserFetch(new Error('socket reset'), 0), true);
  assert.equal(shouldRetryLocalBrowserFetch(new Error('socket reset'), 2), false);
});

test('a timed-out screenshot is not immediately duplicated on the CDP queue', () => {
  assert.equal(
    shouldRetryScreenshotCdpFailure(new Error('CDP direct timeout: Page.captureScreenshot')),
    false,
  );
  assert.equal(
    shouldRetryScreenshotCdpFailure(new Error('CDP direct connection closed: Page.captureScreenshot')),
    true,
  );
});
