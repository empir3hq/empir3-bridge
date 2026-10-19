export interface TabLike {
  targetId: string;
  url?: string;
  title?: string;
  [key: string]: any;
}

export interface EnrichedTab extends TabLike {
  agentControlled: boolean;
  userFocused: boolean;
  bridgeCurrent: boolean;
}

export interface EnrichedTabState {
  currentTargetId: string;
  tabs: EnrichedTab[];
  agentTab: EnrichedTab | null;
  agentTabs: Array<{ agentId: string; agentName: string; targetId: string }>;
}

export interface ActivationOutcome {
  switched: boolean;
  currentTargetId: string;
  tab: TabLike | null;
  error?: string;
}

export function enrichTabState(input: {
  tabs: TabLike[];
  currentTargetId: string;
  agentControlTarget: TabLike | null;
  userFocusTarget: TabLike | null;
  agentTabs?: Array<{ agentId: string; agentName: string; targetId: string }>;
}): EnrichedTabState;

export function activationOutcome(state: { tabs: TabLike[]; currentTargetId: string }, targetId: string): ActivationOutcome;

export function waitForActivation(
  readState: () => Promise<{ tabs: TabLike[]; currentTargetId: string }>,
  targetId: string,
  options?: { settleMs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> },
): Promise<ActivationOutcome>;

export function findTabTarget(tabs: TabLike[], raw: any): TabLike | null;
export function reconcileTabTargets(input: {
  tabs: TabLike[];
  currentTargetId: string;
  agentControlTarget: TabLike | null;
  userFocusTarget: TabLike | null;
  now?: () => Date;
}): { agentControlTarget: TabLike | null; userFocusTarget: TabLike | null; droppedAgent: boolean; fellBack: boolean };

export const ACTIVATION_SETTLE_MS: number;
export const ACTIVATION_POLL_MS: number;
