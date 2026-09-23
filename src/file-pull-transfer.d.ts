export const FILE_PULL_SINGLE_FRAME_SAFE_CHARS: number;
export const FILE_PULL_CHUNK_CHARS: number;

export interface ChunkedFilePullFrame {
  type: 'desktop:file:pull:chunk';
  payload: {
    id: string;
    index: number;
    totalChunks: number;
    encoding: 'base64';
    data: string;
  };
}

export function buildChunkedFilePullTransfer(
  id: string,
  result: Record<string, unknown>,
  options?: { thresholdChars?: number; chunkChars?: number },
): null | {
  frames: ChunkedFilePullFrame[];
  final: { type: 'desktop:file:pull:result'; payload: Record<string, unknown> };
};
