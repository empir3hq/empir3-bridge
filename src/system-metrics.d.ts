export interface DiskStat {
  mount: string;
  totalGb: number;
  freeGb: number;
  percent: number;
}

export interface HealthSnapshot {
  cpuPercent: number | null;
  memPercent: number | null;
  memTotalGb: number | null;
  swapPercent: number | null;
  disks: DiskStat[];
  processCount: number | null;
  batteryPercent: number | null;
  uptimeSec: number;
  hostname: string;
  arch: string;
  partial: boolean;
  errors: string[];
}

export interface CollectOptions {
  includeDisks?: boolean;
  includeProcessCount?: boolean;
  budgetMs?: number;
}

export function collectHealthSnapshot(opts?: CollectOptions): Promise<HealthSnapshot>;
export function cpuPercent(): Promise<number | null>;
export function memoryStats(): { memPercent: number; memTotalGb: number; swapPercent: number | null };
export function diskStats(): Promise<DiskStat[]>;
export function processCount(): number | null;
export function batteryPercent(): number | null;
