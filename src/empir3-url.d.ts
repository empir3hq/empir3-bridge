export const DEFAULT_EMPIR3_SERVER: string;
export const LOCAL_DEV_EMPIR3_SERVER: string;

export type Empir3Environment = 'production' | 'local-dev' | 'custom';

export function normalizeServer(input?: string | null): string;
export function classifyServer(serverUrl?: string | null): Empir3Environment;
export function defaultWsUrl(serverUrl?: string | null): string;
export function normalizeWsUrl(wsUrl: string | undefined | null, serverUrl?: string | null): string;
