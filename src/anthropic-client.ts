/**
 * Anthropic Messages API streaming client — minimal, no SDK dependency.
 *
 * One exported function: `streamMessages` returns an async generator yielding
 * normalized events (`text_delta`, `tool_use_start`, `tool_use_end`,
 * `message_end`, `usage`, `error`). The chat loop in `chat.ts` walks the
 * generator without caring about the SSE wire format.
 *
 * Why hand-rolled instead of @anthropic-ai/sdk: the SDK is ~1MB and pulls
 * in `node-fetch` polyfills we don't need (Node 18+ has native fetch). This
 * file is ~150 LOC + zero dependencies. If we ever want vision or batch
 * we'll reach for the SDK.
 *
 * Tool input arrives as `input_json_delta` events with partial JSON strings
 * that need accumulation. We buffer per content-block index and parse once
 * at `content_block_stop` so the consumer gets a single `tool_use_start`
 * event with fully-formed input.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  >;
}

export interface StreamRequest {
  apiKey: string;
  model: string;
  maxTokens: number;
  system?: string;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string; input: unknown }
  | { type: 'message_end'; stopReason: string | null }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string };

interface PendingToolBlock {
  id: string;
  name: string;
  jsonBuffer: string;
}

export async function* streamMessages(req: StreamRequest): AsyncGenerator<StreamEvent> {
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens,
    stream: true,
    messages: req.messages,
  };
  if (req.system) body.system = req.system;
  if (req.tools && req.tools.length > 0) body.tools = req.tools;

  let response: Response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': req.apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });
  } catch (e: any) {
    yield { type: 'error', message: `Network error: ${e?.message || String(e)}` };
    return;
  }

  if (!response.ok) {
    let errText = '';
    try { errText = await response.text(); } catch { /* ignore */ }
    yield { type: 'error', message: `API ${response.status}: ${errText.slice(0, 500) || response.statusText}` };
    return;
  }
  if (!response.body) {
    yield { type: 'error', message: 'API returned no body' };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const pendingTools = new Map<number, PendingToolBlock>();
  let buffer = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: string | null = null;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by blank lines. Parse complete frames out
      // of the buffer; leave any trailing partial frame for the next chunk.
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        // A frame is one or more "event:" / "data:" lines. We only need data.
        const dataLine = frame.split('\n').find(l => l.startsWith('data:'));
        if (!dataLine) continue;
        const data = dataLine.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        let event: any;
        try { event = JSON.parse(data); } catch { continue; }

        switch (event.type) {
          case 'message_start': {
            const usage = event.message?.usage;
            if (usage?.input_tokens) inputTokens = usage.input_tokens;
            break;
          }
          case 'content_block_start': {
            const block = event.content_block;
            if (block?.type === 'tool_use') {
              pendingTools.set(event.index, { id: block.id, name: block.name, jsonBuffer: '' });
            }
            break;
          }
          case 'content_block_delta': {
            const delta = event.delta;
            if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
              yield { type: 'text_delta', text: delta.text };
            } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
              const pending = pendingTools.get(event.index);
              if (pending) pending.jsonBuffer += delta.partial_json;
            }
            break;
          }
          case 'content_block_stop': {
            const pending = pendingTools.get(event.index);
            if (pending) {
              let parsedInput: unknown = {};
              if (pending.jsonBuffer.length > 0) {
                try { parsedInput = JSON.parse(pending.jsonBuffer); } catch { parsedInput = {}; }
              }
              yield { type: 'tool_use_start', id: pending.id, name: pending.name, input: parsedInput };
              pendingTools.delete(event.index);
            }
            break;
          }
          case 'message_delta': {
            if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
            if (event.usage?.output_tokens) outputTokens = event.usage.output_tokens;
            break;
          }
          case 'message_stop': {
            // Final event — flush usage + end signal
            break;
          }
          default:
            // ignore unknown event types — forward-compat
            break;
        }
      }
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      yield { type: 'message_end', stopReason: 'aborted' };
      return;
    }
    yield { type: 'error', message: `Stream read error: ${e?.message || String(e)}` };
    return;
  }

  if (inputTokens > 0 || outputTokens > 0) {
    yield { type: 'usage', inputTokens, outputTokens };
  }
  yield { type: 'message_end', stopReason };
}
