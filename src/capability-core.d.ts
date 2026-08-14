export type CapabilityKind = 'chat' | 'stt' | 'tts' | 'image';
export type RuntimeCapabilityKind = Exclude<CapabilityKind, 'chat'>;

export const CAPABILITY_KINDS: readonly CapabilityKind[];
export const CAPABILITY_WIRES: Readonly<Record<CapabilityKind, readonly string[]>>;
export const COMFY_WORKFLOW_MAX_BYTES: number;
export const MAX_SYNC_FILE_BYTES: number;

export function normalizeProviderKind(value: unknown): CapabilityKind | null;
export function capabilitiesForKind(value: unknown): string[];
export function capabilityProbePath(kind: unknown, wire: unknown): string;
export function validateCapabilityProviderFields(raw: unknown): {
  ok: boolean;
  error?: string;
  kind?: CapabilityKind;
  wire?: string;
  workflowJson?: string;
};
export function parseWorkflowJson(raw: string): { ok: boolean; error?: string; workflow?: Record<string, unknown> };
export function workflowContainsPlaceholder(value: unknown, placeholder: string): boolean;
export function substituteWorkflowValues<T>(value: T, replacements: Record<string, unknown>): T;
export function decodeInboundBase64(raw: unknown, label: string): { ok: boolean; error?: string; bytes?: Buffer };
export function assetTier(bytes: Uint8Array): 'inline' | 'upload';
