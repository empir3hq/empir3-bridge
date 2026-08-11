export const TRAY_CONSUMER_MAX_AGE_MS = 12_000;

export function trayConsumerActive(lastPollAt: number, now = Date.now()): boolean {
  return Number.isFinite(lastPollAt)
    && lastPollAt > 0
    && now >= lastPollAt
    && now - lastPollAt <= TRAY_CONSUMER_MAX_AGE_MS;
}

export function unavailableTrayCommandMessage(type: string): string {
  if (type === 'tray_apply_update') {
    return 'No legacy tray is connected to apply this update. Use the installed Empir3 Bridge desktop app update action instead.';
  }
  return 'No legacy tray is connected to perform this lifecycle action. Use the installed Empir3 Bridge desktop app instead.';
}
