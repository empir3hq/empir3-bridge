export interface CliUpdateHolder {
  pid: number;
  name: string;
  path?: string;
  parentPid?: number | null;
  parentName?: string | null;
}

export interface CliUpdatePreflightInput {
  provider: string;
  latestRow: { status?: string; installedVersion?: string | null; latestVersion?: string | null } | null | undefined;
  holders?: CliUpdateHolder[];
  force?: boolean;
}

export type CliUpdatePreflightVerdict =
  | { kind: 'current'; installedVersion: string; latestVersion: string | null; message: string }
  | { kind: 'locked'; holders: CliUpdateHolder[]; installedVersion: string | null; latestVersion: string | null; message: string }
  | { kind: 'proceed'; installedVersion: string | null; latestVersion: string | null };

export function decideCliUpdatePreflight(input: CliUpdatePreflightInput): CliUpdatePreflightVerdict;
export function lockHolderMessage(provider: string, holders: CliUpdateHolder[]): string;
export function parseProcessHolders(json: unknown): CliUpdateHolder[];
export function windowsHolderProbeScript(dir: string): string;
