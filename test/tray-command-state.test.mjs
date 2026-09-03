import test from 'node:test';
import assert from 'node:assert/strict';

import { TRAY_CONSUMER_MAX_AGE_MS, trayConsumerActive, unavailableTrayCommandMessage } from '../src/tray-command-state.ts';

test('tray commands require a recent real consumer poll', () => {
  const now = 50_000;
  assert.equal(trayConsumerActive(0, now), false);
  assert.equal(trayConsumerActive(now - TRAY_CONSUMER_MAX_AGE_MS, now), true);
  assert.equal(trayConsumerActive(now - TRAY_CONSUMER_MAX_AGE_MS - 1, now), false);
  assert.equal(trayConsumerActive(now + 1, now), false);
});

test('update refusal tells desktop-package users where the real action lives', () => {
  assert.match(unavailableTrayCommandMessage('tray_apply_update'), /No legacy tray is connected/);
  assert.match(unavailableTrayCommandMessage('tray_apply_update'), /desktop app update action/);
});
