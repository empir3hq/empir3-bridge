import type { PlatformProfile } from './platform-profile';

export interface CapabilityRefusal {
  success: false;
  code: 'capability_unsupported';
  capability: string;
  deviceClass: string;
  platform: string;
  error: string;
  hint: string;
}

export function unsupportedDesktopCommand(
  baseOrType: string,
  action: string,
  profile: PlatformProfile,
): CapabilityRefusal | null;

export function capabilityRefusal(capability: string, profile: PlatformProfile): CapabilityRefusal;

export const WINDOWS_ONLY_DESKTOP_BASES: Record<string, string>;
export const WINDOWS_ONLY_SYSINFO_QUERIES: Set<string>;
