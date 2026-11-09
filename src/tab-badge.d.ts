export const BADGE_PREFIX_RE: RegExp;
export const PRESENCE_PREFIX_RE: RegExp;
export const MAX_AGENT_NAME: number;

export function sanitizeAgentName(name: unknown): string;
export function applyBadge(title: string | null | undefined, agentName: unknown): string;
export function badgeTitleExpression(agentName: unknown): string;
