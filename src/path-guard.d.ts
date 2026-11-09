export interface BlockedPathOptions {
  allowedRoots?: string[];
}
export function blockedCredentialReadPath(target: string, platform?: string): string | null;
export function canonicalReadablePath(target: string, opts?: { platform?: string; allowedRoots?: string[]; protectedPaths?: string[] }): { ok: boolean; target?: string; error?: string };

export function blockedPosixReadPath(target: string, opts?: BlockedPathOptions): string | null;
export function parseAllowedRoots(env?: Record<string, string | undefined>): string[];
export function isUnder(target: string, root: string): boolean;
export const POSIX_BLOCKED_ROOTS: string[];
export const POSIX_BLOCKED_FRAGMENTS: string[];
export const BLOCKED_BASENAMES: RegExp;
