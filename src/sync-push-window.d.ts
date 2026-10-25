export interface SyncPushFailure { path: string; error: string }
export interface SyncPushSummary { totalPushed: number; written: number; failed: SyncPushFailure[]; failedCount: number }

export class SyncPushFailureTracker {
  constructor(limit?: number);
  open: boolean;
  failed: SyncPushFailure[];
  attempted: number;
  succeeded: number;
  begin(): void;
  record(relPath: unknown, result: any): void;
  end(totalPushedFromServer: unknown): SyncPushSummary;
}

export function describeSyncOutcome(sync: any): string | null;
