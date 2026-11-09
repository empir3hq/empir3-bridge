export const ENROLL_TOKEN_RE: RegExp;
export const ETC_ENROLL_FILE: string;
export const USER_ENROLL_FILE: string;

export interface EnrollSource {
  token: string;
  serverUrl: string | null;
  source: 'argv' | 'env' | 'etc' | 'settings';
  file?: string;
}

export function resolveEnrollSource(argv?: string[], env?: Record<string, string | undefined>): EnrollSource | null;

export function enrollIfNeeded(opts?: {
  argv?: string[];
  env?: Record<string, string | undefined>;
  agentVersion?: string;
  log?: (msg: string) => void;
}): Promise<
  | { enrolled: true; deviceId: string; approvalPending: boolean; authFile: string }
  | { enrolled: false; reason: string }
>;
