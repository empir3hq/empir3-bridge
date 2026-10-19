export interface SmokeCheck {
  name: string;
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  detail?: any;
}

export interface SmokeSummary {
  success: boolean;
  ok: boolean;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  checks: SmokeCheck[];
  skippedChecks?: Array<{ name: string; reason: string }>;
  error?: string;
  failures?: Array<{ name: string; error: string }>;
  [extra: string]: any;
}

export function summarizeSmokeChecks(checks: SmokeCheck[], context?: Record<string, any>): SmokeSummary;
export function receiptOutcome(result: any): { ok: boolean; error: string | undefined };
