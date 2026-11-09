export interface CliNativeStopProof {
  version: 1; nonce: string; mechanism: 'windows-job-v1'; started: boolean; pid: number;
  exitCode: number; cancelled: boolean; timedOut: boolean; activeProcesses: 0;
}
export function validNativeStopProof(value: any, nonce: string): value is CliNativeStopProof {
  return value?.version === 1 && value.nonce === nonce && value.mechanism === 'windows-job-v1' && value.activeProcesses === 0
    && typeof value.started === 'boolean' && typeof value.cancelled === 'boolean' && typeof value.timedOut === 'boolean'
    && Number.isSafeInteger(value.pid) && value.pid >= 0 && value.pid <= 0xffffffff && (!value.started || value.pid > 0)
    && Number.isSafeInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 0xffffffff;
}
