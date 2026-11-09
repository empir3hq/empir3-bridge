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

export function updateCapabilities({
  platform = process.platform,
  label = process.env.EMPIR3_BRIDGE_LABEL || '',
  managedHeadless = false,
  trayActive = false,
}: { platform?: string; label?: string; managedHeadless?: boolean; trayActive?: boolean } = {}) {
  const desktop = label === 'DESKTOP' || label === 'ELECTRON-DEV';
  if (platform === 'linux' && managedHeadless && !desktop) return {
    method: 'systemd-path', canApply: true, autoUpdateConfigurable: false, channel: 'packages',
    guidance: 'Updates are handled by the installed Linux service. Apply update requests a check; the Bridge restarts only when a verified update is installed.',
    policy: 'Automatic checks are managed by the empir3-bridge-update.timer service. Change that service on the host to adjust the schedule.',
  };
  if (desktop) return {
    method: 'desktop-app', canApply: false, autoUpdateConfigurable: false, channel: 'packages',
    guidance: label === 'ELECTRON-DEV'
      ? 'This is a development copy. Update its source and restart it, or install a released Empir3 Bridge package.'
      : 'Open the Empir3 Bridge app menu and choose Check for Updates. The app verifies the download and asks before opening the installer.',
    policy: 'The desktop app checks for updates and asks before installing. This console does not control that policy.',
  };
  if (platform === 'win32' && trayActive) return {
    method: 'tray', canApply: true, autoUpdateConfigurable: true, channel: 'legacy',
    guidance: 'Apply update asks the connected Bridge tray app to install the release. The Bridge restarts when it is ready.',
    policy: 'Apply new Bridge updates automatically through the connected tray app.',
  };
  return {
    method: 'manual', canApply: false, autoUpdateConfigurable: false,
    channel: platform === 'win32' ? 'legacy' : 'packages',
    guidance: platform === 'linux'
      ? 'This Linux installation has no managed updater. Update it using its original installation method, or migrate to the signed Linux headless package. An administrator must complete that setup on the host before remote updates can work.'
      : platform === 'darwin'
        ? 'Update this copy using its original installation method, or open Check for Updates in the installed Empir3 Bridge app.'
        : 'No Bridge updater is connected. Open the installed Bridge tray or desktop app and use Check for Updates. For a source or npm install, update using its original installation method.',
    policy: 'Automatic updates are unavailable for this running copy. Changing a preference here would not install updates.',
  };
}
