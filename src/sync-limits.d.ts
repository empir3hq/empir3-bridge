import type { PlatformProfile } from './platform-profile';

export const SYNC_SERVER_FRAME_CAP: number;
export const SYNC_FRAME_SLACK: number;
export const MAX_SYNC_CONTENT_BYTES: number;
export const MAX_SYNC_FILE_BYTES: number;
export const SYNC_BINARY_EXT_RE: RegExp;

export function encodedSyncBytes(content: string, binary: boolean): number;
export function fitsSyncFrame(content: string, binary: boolean): boolean;
export function projectMirrorAllowed(profile: PlatformProfile | null | undefined): boolean;
