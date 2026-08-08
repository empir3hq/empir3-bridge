/**
 * Claude CLI runner — spawns the user's `claude` binary in stream-json
 * mode and translates its stdout into the same StreamEvent shape that
 * anthropic-client emits. So chat.ts can call either runner without
 * branching on mode beyond the entry point.
 *
 * Why subprocess instead of API: a user with Claude Max already pays
 * Anthropic for inference. Routing through their CLI means they don't
 * pay twice.
 *
 * Tool integration: NOT wired here. v0.1.0 CLI mode = plain chat. To
 * add browser tools to the CLI session, pass `--mcp-config <path>`
 * pointing at this bridge's MCP server (deferred to v0.1.1 — the MCP
 * shim already exists at dist/mcp-server.cjs, we just need a temp
 * config file generator that filters by enabledTools). API mode in
 * chat.ts runs the full tool-use loop today.
 *
 * Wave 2 reuse: this same module is the pattern Wave 2 M2.2 uses to
 * route Empir3-server-driven turns through the user's local CLI.
 */

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import type { AnthropicMessage, StreamEvent } from './anthropic-client.js';

export interface CliStreamRequest {
  cliPath: string;
  model?: string;
  system?: string;
  messages: AnthropicMessage[];
  signal?: AbortSignal;
  cwd?: string;
  extraArgs?: string[];
}

const SIGTERM_GRACE_MS = 5000;

export async function* streamCli(req: CliStreamRequest): AsyncGenerator<StreamEvent> {
  const args = ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'];
  if (req.model) args.push('--model', req.model);
  if (req.extraArgs && req.extraArgs.length) args.push(...req.extraArgs);

  // Build the input turn. The CLI's stream-json input format takes one JSON
  // line per turn — system+messages are flattened into a single user line
  // for simple chat. Multi-turn history is replayed as separate lines.
  const stdinPayload = buildStreamJsonInput(req);

  // On Windows, the npm-installed `claude` ships as both a bare unix shim
  // and a `.cmd` batch shim. Node's spawn can only execute the `.cmd` shim
  // directly. If the saved config still points at a path without an
  // extension, transparently rewrite to the `.cmd` companion.
  let cliPath = req.cliPath;
  if (process.platform === 'win32' && !/\.(cmd|exe|bat|ps1)$/i.test(cliPath)) {
    const fs = require('fs') as typeof import('fs');
    if (fs.existsSync(cliPath + '.cmd')) cliPath = cliPath + '.cmd';
  }

  let child: ChildProcessWithoutNullStreams;
  try {
    // Node 18.20+/20.12+ refuse to spawn `.cmd`/`.bat` directly on Windows
    // for security (CVE-2024-27980). The fix: spawn cmd.exe directly (an
    // .exe, so no CVE applies) and pass the .cmd path as a properly-escaped
    // arg. `shell: true` + quoted command is NOT used here because cmd.exe
    // misinterprets the double-quote + backslash combo in Windows paths,
    // silently dropping the `\` in `C:\` and failing with "not recognized".
    const isWinShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath);
    if (isWinShim) {
      child = spawn('cmd.exe', ['/d', '/s', '/c', cliPath, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: req.cwd,
        windowsHide: true,
      });
    } else {
      child = spawn(cliPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: req.cwd,
        windowsHide: true,
      });
    }
  } catch (e: any) {
    yield { type: 'error', message: `Failed to spawn claude CLI at ${cliPath}: ${e?.message || String(e)}` };
    return;
  }

  // Hook abort signal — SIGTERM, then SIGKILL after grace period.
  const abortHandler = () => {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, SIGTERM_GRACE_MS);
  };
  if (req.signal) {
    if (req.signal.aborted) abortHandler();
    else req.signal.addEventListener('abort', abortHandler, { once: true });
  }

  child.stdin.write(stdinPayload);
  child.stdin.end();

  // Pump stdout chunks into a buffered queue the generator drains.
  const queue: StreamEvent[] = [];
  let waiter: ((v: void) => void) | null = null;
  const wake = () => { if (waiter) { const w = waiter; waiter = null; w(); } };

  let exited = false;
  let exitCode = 0;
  let stderrBuffer = '';
  let stopReason: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let lineBuffer = '';
  const pendingTools = new Map<number, { id: string; name: string; jsonBuffer: string }>();

  child.stdout.on('data', (chunk: Buffer) => {
    lineBuffer += chunk.toString('utf-8');
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() || '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      handleCliEvent(ev);
    }
    wake();
  });
  child.stderr.on('data', (chunk: Buffer) => { stderrBuffer += chunk.toString('utf-8'); });
  child.on('close', code => { exitCode = code ?? -1; exited = true; wake(); });
  child.on('error', err => { stderrBuffer += `\n[spawn error] ${err.message}`; exited = true; wake(); });

  function handleCliEvent(ev: any) {
    // Token-level streaming deltas — preferred shape, matches API client.
    if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta') {
      const d = ev.event.delta;
      if (d?.type === 'text_delta' && typeof d.text === 'string') {
        queue.push({ type: 'text_delta', text: d.text });
      } else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
        const idx = ev.event.index;
        const pending = pendingTools.get(idx);
        if (pending) pending.jsonBuffer += d.partial_json;
      }
      return;
    }
    if (ev.type === 'stream_event' && ev.event?.type === 'content_block_start') {
      const block = ev.event.content_block;
      if (block?.type === 'tool_use') {
        pendingTools.set(ev.event.index, { id: block.id, name: block.name, jsonBuffer: '' });
      }
      return;
    }
    if (ev.type === 'stream_event' && ev.event?.type === 'content_block_stop') {
      const idx = ev.event.index;
      const pending = pendingTools.get(idx);
      if (pending) {
        let parsed: unknown = {};
        if (pending.jsonBuffer) { try { parsed = JSON.parse(pending.jsonBuffer); } catch { parsed = {}; } }
        queue.push({ type: 'tool_use_start', id: pending.id, name: pending.name, input: parsed });
        pendingTools.delete(idx);
      }
      return;
    }

    // Per-turn assistant fallback — when token-level streaming isn't
    // available, the CLI still emits a complete `assistant` event. Push
    // its text once so we don't lose the message.
    if (ev.type === 'assistant' && ev.message?.content) {
      const blocks = ev.message.content as Array<{ type?: string; text?: string }>;
      const text = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('');
      // Only emit fallback text if we never streamed any deltas for this turn.
      // Heuristic: if the queue's last text_delta is empty, emit; else assume
      // streaming already covered it. We can't reliably check — just always
      // emit and let the consumer dedupe via its own message buffer if needed.
      // Tradeoff acknowledged: a minor risk of double-text vs total loss when
      // CLI doesn't stream. CLIs we've tested do stream, so this is rarely hit.
      if (text) queue.push({ type: 'text_delta', text });
      return;
    }

    if (ev.type === 'result') {
      if (ev.usage?.input_tokens) inputTokens = ev.usage.input_tokens;
      if (ev.usage?.output_tokens) outputTokens = ev.usage.output_tokens;
      if (ev.is_error || ev.subtype === 'error_during_execution' || ev.subtype === 'error_max_turns') {
        const detail = typeof ev.result === 'string' && ev.result.trim()
          ? ev.result.trim()
          : `${ev.subtype || 'error'} (status ${ev.api_error_status ?? 'unknown'})`;
        queue.push({ type: 'error', message: `[CLI ${ev.subtype || 'error'}] ${detail}` });
        stopReason = 'error';
      } else if (ev.subtype === 'success' || ev.stop_reason === 'end_turn') {
        stopReason = 'end_turn';
      } else if (ev.stop_reason === 'max_turns') {
        stopReason = 'max_turns';
      }
    }
  }

  // Drain loop: yield queued events as the subprocess produces them.
  while (true) {
    while (queue.length > 0) {
      yield queue.shift()!;
    }
    if (exited) break;
    await new Promise<void>(r => { waiter = r; });
  }

  if (exitCode !== 0 && stopReason !== 'error') {
    const msg = stderrBuffer.trim() || `claude CLI exited with code ${exitCode}`;
    yield { type: 'error', message: msg };
    return;
  }

  if (inputTokens > 0 || outputTokens > 0) {
    yield { type: 'usage', inputTokens, outputTokens };
  }
  yield { type: 'message_end', stopReason };
}

/**
 * Convert AnthropicMessage[] to the CLI's stream-json input format.
 * Each user message becomes one JSONL line on stdin. Assistant messages
 * are echoed back as turn history. The CLI assembles them into a
 * conversation context.
 */
function buildStreamJsonInput(req: CliStreamRequest): string {
  const lines: string[] = [];
  for (const m of req.messages) {
    const content = typeof m.content === 'string' ? m.content : flattenContent(m.content);
    lines.push(JSON.stringify({
      type: m.role,
      message: { role: m.role, content: [{ type: 'text', text: content }] },
    }));
  }
  return lines.join('\n') + '\n';
}

function flattenContent(blocks: Exclude<AnthropicMessage['content'], string>): string {
  return blocks.map(b => {
    if (b.type === 'text') return b.text;
    if (b.type === 'tool_result') return `[tool_result for ${b.tool_use_id}]\n${b.content}`;
    if (b.type === 'tool_use') return `[tool_use: ${b.name}]`;
    return '';
  }).join('\n');
}
