export type DeviceClass = 'workstation' | 'server';

export interface PlatformProfile {
  /** 'windows' | 'macos' | 'linux' | other process.platform values */
  os: string;
  /** Human label: 'Windows', 'macOS', or the Linux distro PRETTY_NAME */
  osPretty: string;
  arch: string;
  headless: boolean;
  hasDisplay: boolean;
  deviceClass: DeviceClass;
  container: boolean;
  distro: string;
}

export interface PlatformProfileOverrides {
  platform?: string;
  arch?: string;
  env?: Record<string, string | undefined>;
  fsExists?: (p: string) => boolean;
  readText?: (p: string) => string;
}

export function computePlatformProfile(overrides?: PlatformProfileOverrides): PlatformProfile;
export function getPlatformProfile(): PlatformProfile;
