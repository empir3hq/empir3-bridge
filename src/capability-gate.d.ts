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

export interface DesktopAvailability {
  available: boolean;
  backend: 'windows' | 'x11' | null;
  code: string | null;
  reason: string;
  hint: string;
  /** Present when unavailable: the single sentence every desktop tool emits. */
  message?: string;
  display?: string;
  supported?: string[];
}

export interface DesktopAvailabilityOptions {
  missingTools?: string[];
  toolStatus?: Record<string, boolean>;
}

export function capabilityRefusal(capability: string, profile: PlatformProfile, options?: DesktopAvailabilityOptions): CapabilityRefusal & { availability: Pick<DesktopAvailability, 'available' | 'backend' | 'code' | 'reason'> };
export function desktopAvailability(profile: PlatformProfile, options?: DesktopAvailabilityOptions): DesktopAvailability;
export function desktopUnavailableMessage(profile: PlatformProfile, options?: DesktopAvailabilityOptions): string;
export const DESKTOP_UNAVAILABLE_PREFIX: string;
export const X11_REQUIRED_TOOLS: string[];

export const WINDOWS_ONLY_DESKTOP_BASES: Record<string, string>;
export const WINDOWS_ONLY_SYSINFO_QUERIES: Set<string>;
