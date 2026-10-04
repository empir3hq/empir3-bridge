export interface EmulationReadback {
  innerWidth?: number;
  innerHeight?: number;
  maxTouchPoints?: number;
  ontouchstart?: boolean;
  dpr?: number;
}

export interface EmulationConsistency {
  checked: boolean;
  viewportMatches: boolean | null;
  touchConsistent: boolean | null;
  delta?: { width: number; height: number };
  reloadRequired: boolean;
  notes: string[];
}

export function emulationConsistency(
  requested: { width: number; height: number },
  measured: EmulationReadback | null | undefined,
): EmulationConsistency;
