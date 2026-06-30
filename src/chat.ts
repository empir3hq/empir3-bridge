/**
 * Chat orchestration — picks a runner (api | cli), runs the tool-use
 * loop, persists every turn, yields a unified event stream the HTTP/SSE
 * layer can serialize to the overlay.
 *
 * Responsibilities split:
 *   - anthropic-client.ts streams raw model events
 *   - cli-runner.ts streams the same shape from a `claude` subprocess
 *   - this file picks one, drives the tool-use loop in API mode, and
 *     dispatches tool calls back through the bridge's HTTP API
 *
 * Tool-use loop (API mode only):
 *   1. Send messages + tools to the API, stream events
 *   2. On tool_use_start → dispatch via /api/command, capture result
 *   3. After message_end, if stop_reason === 'tool_use':
 *      append assistant turn + tool_result turn to messages, restart
 *   4. Loop caps at config.maxLoopIterations
 *
 * CLI mode currently runs without tool-use (see cli-runner.ts header).
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { streamMessages, type AnthropicMessage, type AnthropicTool, type StreamEvent } from './anthropic-client.js';
import { streamCli } from './cli-runner.js';
import { loadConfig, type BridgeConfig, configReady } from './config.js';
import { TOOL_META } from './tool-defaults.js';

const CONV_DIR = join(homedir(), '.empir3-bridge', 'conversations');

// ── Public chat-event shape (what the server SSE relays) ─────────

export type ChatEvent =
  | { type: 'message_start'; conversationId: string; role: 'assistant' }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; output: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'message_end'; stopReason: string | null; iterations: number }
  | { type: 'error'; message: string };

export interface StreamChatRequest {
  messages: AnthropicMessage[];
  conversationId?: string;
  modeOverride?: 'api' | 'cli';
  signal?: AbortSignal;
  bridgeBaseUrl?: string; // default localhost:<bridgePort> at server start; injected by server.ts
}

const DEFAULT_SYSTEM_PROMPT =
  'You are Claude, running inside a local browser-bridge daemon. The user is viewing a web page in a Chrome window controlled by this bridge. ' +
  'When you need to see or interact with the page, call the appropriate browser_* tool. Prefer browser_snapshot over browser_screenshot — it returns the accessibility tree with element refs (e0, e1, etc) which are cheaper and more reliable than coordinates. ' +
  'Be concise. Only act when the user actually needs an action.';

// ── Tool input schemas mirror src/mcp-server.ts so what the model
//    sees in API mode is identical to what Claude Code sees through MCP.

const TOOL_SCHEMAS: Record<string, AnthropicTool['input_schema']> = {
  bridge_overlay_reinject: { type: 'object', properties: {} },
  browser_status:       { type: 'object', properties: {} },
  browser_text:         { type: 'object', properties: {} },
  browser_screenshot:   { type: 'object', properties: {} },
  desktop_monitors:     { type: 'object', properties: {} },
  desktop_screenshot:   { type: 'object', properties: { monitor: { type: 'string', description: 'all, primary, DISPLAY1, DISPLAY2, or full device name. Default: all' } } },
  browser_snapshot:     { type: 'object', properties: { filter: { type: 'string', enum: ['interactive', 'all'], description: 'Default: interactive' } } },
  browser_navigate:     { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  browser_scroll:       { type: 'object', properties: { y: { type: 'number', description: 'Vertical pixels (positive=down, negative=up)' }, x: { type: 'number' } }, required: ['y'] },
  browser_refresh:      { type: 'object', properties: {} },
  browser_click:        { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] },
  browser_click_ref:    { type: 'object', properties: { ref: { type: 'string', description: 'Element ref from snapshot (e.g. "e5")' } }, required: ['ref'] },
  browser_click_xy:     { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
  desktop_click:        { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, monitor: { type: 'string', description: 'Optional monitor id. When supplied, x/y are monitor-relative.' }, double: { type: 'boolean' }, button: { type: 'string', enum: ['left', 'right', 'middle'] } }, required: ['x', 'y'] },
  desktop_hover:        { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, monitor: { type: 'string', description: 'Optional monitor id. When supplied, x/y are monitor-relative.' } }, required: ['x', 'y'] },
  desktop_drag:         { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, toX: { type: 'number' }, toY: { type: 'number' }, monitor: { type: 'string', description: 'Optional monitor id. When supplied, both endpoints are monitor-relative.' }, durationMs: { type: 'number' }, steps: { type: 'number' }, button: { type: 'string', enum: ['left', 'right', 'middle'] } }, required: ['x', 'y', 'toX', 'toY'] },
  browser_type:         { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' } }, required: ['selector', 'text'] },
  browser_type_ref:     { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' } }, required: ['ref', 'text'] },
  browser_press:        { type: 'object', properties: { key: { type: 'string', description: 'e.g. "Enter", "Tab", "Control+a"' } }, required: ['key'] },
  browser_highlight:    { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] },
  browser_evaluate:     { type: 'object', properties: { script: { type: 'string', description: 'JS expression to evaluate on the page' } }, required: ['script'] },
  browser_chat:         { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
  browser_read_chat:    { type: 'object', properties: { limit: { type: 'number' } } },
  browser_record_start: { type: 'object', properties: {} },
  browser_record_stop:  { type: 'object', properties: { name: { type: 'string' } } },
  browser_play:         { type: 'object', properties: { recording: { type: 'string' }, speed: { type: 'number' }, variables: { type: 'object' } }, required: ['recording'] },
  browser_recordings:   { type: 'object', properties: {} },
};

function buildToolDefs(cfg: BridgeConfig): AnthropicTool[] {
  const tools: AnthropicTool[] = [];
  for (const meta of TOOL_META) {
    if (!cfg.enabledTools[meta.name]) continue;
    const schema = TOOL_SCHEMAS[meta.name];
    if (!schema) continue;
    tools.push({ name: meta.name, description: meta.blurb, input_schema: schema });
  }
  return tools;
}

// ── Bridge-side dispatch ────────────────────────────────────────

async function dispatchTool(name: string, input: any, bridgeBaseUrl: string): Promise<{ ok: boolean; output: string }> {
  // /api/command wraps responses as { ok, result } | { ok:false, error }.
  // Unwrap to result so dispatch sites can read fields directly.
  const post = async (cmd: any) => {
    const r = await fetch(`${bridgeBaseUrl}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text().catch(() => '')}`);
    const env = await r.json();
    if (env && typeof env === 'object' && 'ok' in env) {
      if (!env.ok) throw new Error(env.error || 'command failed');
      return env.result ?? {};
    }
    return env;
  };
  const get = async (path: string) => {
    const r = await fetch(`${bridgeBaseUrl}${path}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };

  try {
    switch (name) {
      case 'browser_status':       return ok(JSON.stringify(await get('/api/status'), null, 2));
      case 'bridge_overlay_reinject': return ok(JSON.stringify(await post({ type: 'overlay_reinject', reason: 'chat' }), null, 2));
      case 'browser_text':         return ok((await post({ type: 'text' })).text || '(no text)');
      case 'browser_snapshot': {
        const r = await post({ type: 'snapshot', filter: input?.filter || 'interactive', format: 'compact' });
        return ok(typeof r.snapshot === 'string' ? r.snapshot : JSON.stringify(r.snapshot, null, 2));
      }
      case 'browser_screenshot': {
        const r = await fetch(`${bridgeBaseUrl}/api/screenshot?quality=50`);
        if (!r.ok) return fail(`screenshot HTTP ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        return ok(`[screenshot captured: ${buf.byteLength} bytes JPEG]`);
      }
      case 'desktop_monitors':     return ok(JSON.stringify(await post({ type: 'desktop_monitors' }), null, 2));
      case 'desktop_screenshot':   return ok(JSON.stringify(await post({ type: 'desktop_screenshot', monitor: input?.monitor || 'all' }), null, 2));
      case 'browser_navigate':     return ok(`Navigated to: ${(await post({ type: 'navigate', url: input.url })).url}`);
      case 'browser_scroll': {
        const r = await post({ type: 'scroll', x: input.x || 0, y: input.y });
        return ok(JSON.stringify({ requested: r.scrolled, moved: r.moved, position: r.position, scroll: r.scroll }, null, 2));
      }
      case 'browser_refresh':      { await post({ type: 'refresh' }); return ok('Page refreshed'); }
      case 'browser_click':        { await post({ type: 'click', selector: input.selector }); return ok(`Clicked: ${input.selector}`); }
      case 'browser_click_ref':    { await post({ type: 'click_ref', ref: input.ref }); return ok(`Clicked ref: ${input.ref}`); }
      case 'browser_click_xy':     { await post({ type: 'click_xy', x: input.x, y: input.y }); return ok(`Clicked coordinates: ${input.x},${input.y}`); }
      case 'desktop_click':        {
        const r = await post({ type: 'desktop_click', x: input.x, y: input.y, monitor: input.monitor, space: input.monitor ? 'monitor' : 'desktop', double: !!input.double, button: input.button || 'left' });
        return ok(JSON.stringify(r, null, 2));
      }
      case 'desktop_hover':        {
        const r = await post({ type: 'desktop_hover', x: input.x, y: input.y, monitor: input.monitor, space: input.monitor ? 'monitor' : 'desktop' });
        return ok(JSON.stringify(r, null, 2));
      }
      case 'desktop_drag':         {
        const r = await post({ type: 'desktop_drag', x: input.x, y: input.y, toX: input.toX, toY: input.toY, monitor: input.monitor, space: input.monitor ? 'monitor' : 'desktop', durationMs: input.durationMs, steps: input.steps, button: input.button || 'left' });
        return ok(JSON.stringify(r, null, 2));
      }
      case 'browser_type':         { await post({ type: 'type', selector: input.selector, text: input.text }); return ok(`Typed into ${input.selector}`); }
      case 'browser_type_ref':     { await post({ type: 'type_ref', ref: input.ref, text: input.text }); return ok(`Typed into ref:${input.ref}`); }
      case 'browser_press':        { await post({ type: 'press', text: input.key }); return ok(`Pressed: ${input.key}`); }
      case 'browser_highlight':    { await post({ type: 'highlight', selector: input.selector }); return ok(`Highlighted: ${input.selector}`); }
      case 'browser_evaluate':     return ok(JSON.stringify(await post({ type: 'evaluate', script: input.script }), null, 2));
      case 'browser_chat':         { await post({ type: 'chat', message: input.message }); return ok(`Sent to overlay: ${input.message}`); }
      case 'browser_read_chat': {
        const messages = await get('/api/chat');
        const limit = typeof input?.limit === 'number' ? input.limit : 20;
        const recent = (messages as any[]).slice(-limit);
        if (recent.length === 0) return ok('(no messages)');
        return ok(recent.map(m => `[${m.from}] ${m.text}`).join('\n'));
      }
      case 'browser_record_start': return ok(`Recording started at ${(await post({ type: 'record_start' })).startUrl}`);
      case 'browser_record_stop':  {
        const r = await post({ type: 'record_stop', text: input?.name });
        return ok(`Saved ${r.saved} (${r.actionCount} actions, ${(r.duration / 1000).toFixed(1)}s)`);
      }
      case 'browser_play': {
        const r = await post({ type: 'play', recording: input.recording, speed: input.speed || 1, variables: input.variables || {} });
        return ok(`Playback: ${r.passed}/${r.total} passed, ${r.failed} failed`);
      }
      case 'browser_recordings':   {
        const list = await get('/api/recordings') as any[];
        return ok(list.length === 0 ? '(no recordings)' : list.map(r => `${r.name} (${r.actionCount} actions, ${(r.duration / 1000).toFixed(1)}s)`).join('\n'));
      }
      default:                     return fail(`Unknown tool: ${name}`);
    }
  } catch (e: any) {
    return fail(e?.message || String(e));
  }
}
const ok = (output: string) => ({ ok: true, output });
const fail = (output: string) => ({ ok: false, output });

// ── Persistence ────────────────────────────────────────────────

function ensureConvDir() {
  if (!existsSync(CONV_DIR)) mkdirSync(CONV_DIR, { recursive: true });
}

function persistTurn(conversationId: string, entry: any) {
  try {
    ensureConvDir();
    appendFileSync(join(CONV_DIR, `${conversationId}.jsonl`), JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n');
  } catch { /* swallow — persistence is best-effort */ }
}

export function listConversations(): Array<{ id: string; size: number; mtime: string }> {
  try {
    ensureConvDir();
    const files = readdirSync(CONV_DIR).filter(f => f.endsWith('.jsonl'));
    return files.map(f => {
      const stat = require('fs').statSync(join(CONV_DIR, f));
      return { id: f.replace(/\.jsonl$/, ''), size: stat.size, mtime: stat.mtime.toISOString() };
    }).sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch { return []; }
}

export function readConversation(id: string): any[] {
  try {
    const path = join(CONV_DIR, `${id}.jsonl`);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ── Main entry ─────────────────────────────────────────────────

export async function* streamChat(req: StreamChatRequest): AsyncGenerator<ChatEvent> {
  const cfg = loadConfig();
  const ready = configReady(cfg);
  if (!ready.ready) { yield { type: 'error', message: ready.reason || 'Config not ready' }; return; }

  const mode = req.modeOverride || cfg.mode;
  const conversationId = req.conversationId || randomUUID();
  const bridgeBaseUrl = req.bridgeBaseUrl || `http://localhost:3006`;
  const system = cfg.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const tools = buildToolDefs(cfg);

  yield { type: 'message_start', conversationId, role: 'assistant' };

  // Persist the user's most recent turn (if any) so the conversation
  // log lines up with the prompt that produced this stream.
  const lastUser = [...req.messages].reverse().find(m => m.role === 'user');
  if (lastUser) persistTurn(conversationId, { role: 'user', content: lastUser.content });

  // CLI mode: no tool-use loop in v0.1.0. Also no multi-turn history —
  // the `claude` CLI treats each input line as its own turn and responds
  // separately, which produces N replies instead of one when we replay
  // a conversation. Until v0.1.1 wires up --resume <session-id>, we send
  // only the latest user message and rely on the CLI for that single turn.
  if (mode === 'cli') {
    const latestUser = [...req.messages].reverse().find(m => m.role === 'user');
    const cliMessages = latestUser ? [latestUser] : req.messages;
    let assistantText = '';
    for await (const ev of streamCli({
      cliPath: cfg.claudeCliPath,
      model: cfg.model,
      system,
      messages: cliMessages,
      signal: req.signal,
    })) {
      if (ev.type === 'text_delta') { assistantText += ev.text; yield ev; }
      else if (ev.type === 'usage') yield ev;
      else if (ev.type === 'message_end') yield { type: 'message_end', stopReason: ev.stopReason, iterations: 1 };
      else if (ev.type === 'error') yield ev;
    }
    if (assistantText) persistTurn(conversationId, { role: 'assistant', content: assistantText, mode: 'cli' });
    return;
  }

  // API mode with tool-use loop.
  const messages: AnthropicMessage[] = [...req.messages];
  let iter = 0;
  while (iter < cfg.maxLoopIterations) {
    iter++;
    let assistantText = '';
    const toolUses: Array<{ id: string; name: string; input: any }> = [];
    let lastStopReason: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const ev of streamMessages({
      apiKey: cfg.anthropicApiKey,
      model: cfg.model,
      maxTokens: cfg.maxTokens,
      system,
      messages,
      tools,
      signal: req.signal,
    })) {
      if (ev.type === 'text_delta') { assistantText += ev.text; yield ev; }
      else if (ev.type === 'tool_use_start') {
        toolUses.push({ id: ev.id, name: ev.name, input: ev.input });
        yield { type: 'tool_use', id: ev.id, name: ev.name, input: ev.input };
      }
      else if (ev.type === 'usage') { inputTokens = ev.inputTokens; outputTokens = ev.outputTokens; yield ev; }
      else if (ev.type === 'message_end') { lastStopReason = ev.stopReason; }
      else if (ev.type === 'error') { yield ev; persistTurn(conversationId, { role: 'error', message: ev.message }); return; }
    }

    // Append assistant's turn to history. Preserve tool_use blocks so the
    // next call has a complete record.
    const assistantContent: any[] = [];
    if (assistantText) assistantContent.push({ type: 'text', text: assistantText });
    for (const tu of toolUses) assistantContent.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
    if (assistantContent.length > 0) {
      messages.push({ role: 'assistant', content: assistantContent });
      persistTurn(conversationId, { role: 'assistant', content: assistantContent, mode: 'api', stopReason: lastStopReason, inputTokens, outputTokens, iter });
    }

    if (lastStopReason !== 'tool_use' || toolUses.length === 0) {
      yield { type: 'message_end', stopReason: lastStopReason, iterations: iter };
      return;
    }

    // Defense-in-depth: refuse any tool name that's not in the enabled list.
    // (anthropic-client should never emit one because we filter the tools
    // array, but trust nothing.)
    const toolResults: any[] = [];
    for (const tu of toolUses) {
      let result: { ok: boolean; output: string };
      if (!cfg.enabledTools[tu.name]) {
        result = { ok: false, output: `Tool ${tu.name} is disabled in bridge settings (localhost:3006/settings).` };
      } else {
        result = await dispatchTool(tu.name, tu.input, bridgeBaseUrl);
      }
      yield { type: 'tool_result', id: tu.id, name: tu.name, ok: result.ok, output: result.output };
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: result.output, ...(result.ok ? {} : { is_error: true }) });
      persistTurn(conversationId, { role: 'tool_result', toolUseId: tu.id, name: tu.name, ok: result.ok, output: result.output });
    }
    messages.push({ role: 'user', content: toolResults });
    // Loop continues with the tool results in context.
  }

  yield { type: 'error', message: `Tool-use loop exceeded ${cfg.maxLoopIterations} iterations` };
}
