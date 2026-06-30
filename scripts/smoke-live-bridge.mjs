#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const BRIDGE = process.env.BRIDGE_SMOKE_URL || 'http://127.0.0.1:3006';
const INSTALLER = process.env.BRIDGE_SMOKE_INSTALLER || join(ROOT, 'build', 'dist', 'Empir3Setup.exe');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = resolve(process.env.BRIDGE_SMOKE_OUT || join(ROOT, 'build', `live-smoke-${STAMP}`));
const REPORT_PATH = join(OUT_DIR, 'report.json');
const SUMMARY_PATH = join(OUT_DIR, 'summary.md');

mkdirSync(OUT_DIR, { recursive: true });

const report = {
  startedAt: new Date().toISOString(),
  bridge: BRIDGE,
  installer: INSTALLER,
  outDir: OUT_DIR,
  checks: [],
  artifacts: {},
};

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

function log(message) {
  console.log(`[live-smoke] ${message}`);
}

function compact(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (/^[A-Za-z0-9+/=]{1200,}$/.test(value)) return `[base64 ${value.length} chars]`;
    return value.length > 900 ? `${value.slice(0, 900)}... (${value.length} chars)` : value;
  }
  if (typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return `[buffer ${value.length} bytes]`;
  if (Array.isArray(value)) {
    const first = value.slice(0, 8).map((item) => compact(item, depth + 1));
    if (value.length > 8) first.push(`... ${value.length - 8} more`);
    return first;
  }
  if (depth > 5) return '[object]';
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/data|base64|thumbnail|screenshot/i.test(key) && typeof item === 'string') {
      out[key] = `[base64 ${item.length} chars]`;
    } else {
      out[key] = compact(item, depth + 1);
    }
  }
  return out;
}

async function withTimeout(promise, label, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(`${label} timed out after ${timeoutMs}ms`), timeoutMs);
  try {
    return await promise(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(method, url, body, timeoutMs = 45000) {
  return withTimeout(async (signal) => {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    if (!res.ok) throw new Error(`${method} ${url} failed ${res.status}: ${text.slice(0, 500)}`);
    return parsed ?? text;
  }, `${method} ${url}`, timeoutMs);
}

async function getJson(path, timeoutMs) {
  return requestJson('GET', `${BRIDGE}${path}`, undefined, timeoutMs);
}

async function postJson(path, body, timeoutMs) {
  return requestJson('POST', `${BRIDGE}${path}`, body, timeoutMs);
}

async function command(cmd, timeoutMs = 45000) {
  const body = await postJson('/api/command', cmd, timeoutMs);
  if (!body?.ok) throw new Error(body?.error || `Command failed: ${JSON.stringify(body)}`);
  const result = body.result;
  if (result?.success === false) throw new Error(result.error || result.stderr || `Command returned success=false: ${JSON.stringify(compact(result))}`);
  return result;
}

async function commandAllowFailure(cmd, timeoutMs = 45000) {
  const body = await postJson('/api/command', cmd, timeoutMs);
  return body;
}

async function step(name, fn, options = {}) {
  const started = Date.now();
  log(`${name} ...`);
  try {
    const detail = await fn();
    const check = { name, ok: true, elapsedMs: Date.now() - started, detail: compact(detail) };
    report.checks.push(check);
    log(`PASS ${name}`);
    writeReport();
    return detail;
  } catch (error) {
    const check = { name, ok: false, elapsedMs: Date.now() - started, error: error?.stack || error?.message || String(error) };
    report.checks.push(check);
    log(`FAIL ${name}: ${error?.message || error}`);
    writeReport();
    if (options.fatal) throw error;
    return null;
  }
}

function writeReport() {
  report.updatedAt = new Date().toISOString();
  report.ok = report.checks.every((check) => check.ok);
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  const passed = report.checks.filter((check) => check.ok).length;
  const failed = report.checks.filter((check) => !check.ok);
  const lines = [
    '# Empir3 Bridge Live Smoke',
    '',
    `- Started: ${report.startedAt}`,
    `- Updated: ${report.updatedAt}`,
    `- Bridge: ${BRIDGE}`,
    `- Checks: ${passed}/${report.checks.length} passed`,
    '',
  ];
  if (failed.length) {
    lines.push('## Failures', '');
    for (const check of failed) lines.push(`- ${check.name}: ${String(check.error || '').split('\n')[0]}`);
    lines.push('');
  }
  lines.push('## Checks', '');
  for (const check of report.checks) {
    lines.push(`- ${check.ok ? 'PASS' : 'FAIL'} ${check.name} (${check.elapsedMs}ms)`);
  }
  writeFileSync(SUMMARY_PATH, `${lines.join('\n')}\n`);
}

function ps(command, timeoutMs = 30000) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  }).trim();
}

function listenerProvenance() {
  try {
    const json = ps(`
$ports = 3006,9867
$listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in $ports } | Select-Object LocalAddress,LocalPort,OwningProcess
$procs = foreach ($p in ($listeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
  Get-Process -Id $p -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path
}
[pscustomobject]@{ listeners=$listeners; processes=$procs } | ConvertTo-Json -Depth 6
`, 15000);
    return JSON.parse(json || '{}');
  } catch (error) {
    return { error: error?.message || String(error) };
  }
}

function liveTestHtml(label = 'direct') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Empir3 Bridge Live Smoke</title>
<style>
body{margin:0;font-family:Segoe UI,Arial,sans-serif;background:#09111f;color:#e6edf7;min-height:2200px}
header{position:sticky;top:0;z-index:10;background:#111d31;border-bottom:1px solid #294263;padding:16px 22px}
h1{font-size:22px;margin:0 0 4px}.sub{color:#9db0ca;font-size:13px}
main{padding:24px;display:grid;grid-template-columns:minmax(340px,640px) 1fr;gap:20px}
.panel{border:1px solid #294263;background:#111a2b;padding:16px;border-radius:8px}
button,input,textarea{font:16px Segoe UI,Arial,sans-serif;border-radius:6px;border:1px solid #3d5778;padding:10px 12px}
button{background:#e8f1ff;color:#08111f;font-weight:700;cursor:pointer;margin:4px}
input,textarea{background:#07101d;color:#e6edf7;display:block;margin:8px 0;width:90%;max-width:480px}
#log{white-space:pre-wrap;min-height:260px;max-height:600px;overflow:auto;background:#07101d;border:1px solid #294263;border-radius:8px;padding:12px}
.target{width:240px;height:110px;border:2px solid #48d597;display:grid;place-items:center;margin:18px 0;border-radius:8px;background:rgba(72,213,151,.1)}
.spacer{height:900px}
</style></head><body>
<header><h1>Empir3 Bridge Live Smoke - ${label}</h1><div class="sub">You should see clicks, typing, highlights, scrolling, chat overlay, and recording/playback happen here.</div></header>
<main>
<section class="panel">
  <button id="selectorBtn">Selector button</button>
  <button id="refBtn">Ref button</button>
  <button id="xyBtn">XY target</button>
  <button id="recordBtn">Record target</button>
  <input id="selectorInput" aria-label="Selector Input" placeholder="selector input">
  <input id="refInput" aria-label="Ref Input" placeholder="ref input">
  <input id="mcpInput" aria-label="MCP Input" placeholder="mcp input">
  <textarea id="notes" aria-label="Notes" placeholder="notes"></textarea>
  <div class="target" id="highlightMe">highlight target</div>
  <div class="target" id="dragTarget">browser visible target</div>
</section>
<section class="panel"><h2>Live event log</h2><div id="log">ready</div></section>
</main>
<div class="spacer"></div>
<script>
window.smokeState={selectorClicks:0,refClicks:0,xyClicks:0,recordClicks:0,plays:0,typed:[]};
function line(msg){const log=document.getElementById('log');log.textContent+='\\n'+new Date().toLocaleTimeString()+'  '+msg;log.scrollTop=log.scrollHeight;}
function wire(id,key){document.getElementById(id).addEventListener('click',e=>{window.smokeState[key]++;line(id+' clicked trusted='+e.isTrusted+' count='+window.smokeState[key]);});}
wire('selectorBtn','selectorClicks');wire('refBtn','refClicks');wire('xyBtn','xyClicks');wire('recordBtn','recordClicks');
for (const id of ['selectorInput','refInput','mcpInput','notes']) document.getElementById(id).addEventListener('input',e=>{window.smokeState.typed.push(id+':'+e.target.value);line(id+' input='+e.target.value);});
window.__smokeSummary=()=>({state:window.smokeState,scrollY:window.scrollY,title:document.title,url:location.href});
</script></body></html>`;
}

function dataUrl(html) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function flattenSnapshot(snapshot) {
  if (!snapshot) return [];
  if (Array.isArray(snapshot)) return snapshot;
  if (Array.isArray(snapshot.elements)) return snapshot.elements;
  if (Array.isArray(snapshot.nodes)) return snapshot.nodes;
  if (Array.isArray(snapshot.tree)) return snapshot.tree;
  if (typeof snapshot === 'object') {
    const found = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.ref || node.role || node.name) found.push(node);
      for (const key of ['children', 'nodes', 'items']) {
        if (Array.isArray(node[key])) node[key].forEach(walk);
      }
    };
    walk(snapshot);
    return found;
  }
  return [];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function getBrowserSummary() {
  const result = await command({ type: 'evaluate', script: 'window.__smokeSummary && window.__smokeSummary()' });
  return typeof result?.result === 'string' ? JSON.parse(result.result) : result?.result;
}

async function browserDirectSmoke() {
  const url = dataUrl(liveTestHtml('direct api'));
  await step('browser show controlled window', async () => command({ type: 'desktop:browse:show', params: { url } }));
  await wait(1200);
  await step('browser status', async () => command({ type: 'status' }));
  await step('browser navigate', async () => command({ type: 'navigate', url }));
  await wait(1000);
  await step('browser snapshot direct', async () => {
    const result = await command({ type: 'snapshot', filter: 'all', format: 'json' });
    const elements = flattenSnapshot(result.snapshot);
    assert(elements.length > 0, 'snapshot returned no elements');
    return { count: elements.length, first: elements.slice(0, 6) };
  });
  await step('browser text direct', async () => {
    const result = await command({ type: 'text' });
    assert(/Empir3 Bridge Live Smoke/.test(result.text || ''), 'text did not include live smoke title');
    return { length: result.text.length };
  });
  await step('browser type selector direct', async () => command({ type: 'type', selector: '#selectorInput', text: 'selector direct typed' }));
  await step('browser click selector direct', async () => command({ type: 'click', selector: '#selectorBtn' }));
  await step('browser press direct', async () => command({ type: 'press', text: 'Tab' }));
  await step('browser scroll direct', async () => command({ type: 'scroll', y: 420, x: 0 }));
  await step('browser cursor move direct', async () => command({ type: 'cursor_move', x: 180, y: 180 }));
  await step('browser click xy direct', async () => {
    await command({ type: 'evaluate', script: 'window.scrollTo(0,0); true' });
    await wait(250);
    const pos = await command({
      type: 'evaluate',
      script: `(() => { const r = document.querySelector('#xyBtn').getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()`,
    });
    const point = typeof pos.result === 'string' ? JSON.parse(pos.result) : pos.result;
    const clicked = await command({ type: 'click_xy', x: point.x, y: point.y });
    await wait(300);
    const summary = await getBrowserSummary();
    assert(summary.state.xyClicks >= 1, `xy click did not register: ${JSON.stringify(summary)}`);
    return { point, clicked, xyClicks: summary.state.xyClicks };
  });
  await step('browser evaluate direct', async () => {
    const summary = await getBrowserSummary();
    assert(summary.state.selectorClicks >= 1, 'selector click did not register');
    assert(summary.state.typed.some((item) => item.includes('selector direct typed')), 'selector type did not register');
    return summary;
  });
  await step('browser highlight direct', async () => command({ type: 'highlight', selector: '#highlightMe' }));
  await step('browser screenshot direct', async () => {
    const result = await command({ type: 'screenshot' });
    assert(result.path || result.screenshot, 'browser screenshot did not return a path/name');
    return result;
  });
  await step('browser refresh direct', async () => command({ type: 'refresh' }));
  await wait(1200);
}

async function browserAliasSmoke() {
  const url = dataUrl(liveTestHtml('desktop:browse aliases'));
  await step('agent-browser show alias', async () => command({ type: 'desktop:agent-browser:show', params: { url } }));
  await wait(1000);
  await step('browse status alias', async () => command({ type: 'desktop:browse:status' }));
  await step('browse navigate alias', async () => command({ type: 'desktop:browse:navigate', url }));
  await wait(900);
  await step('browse type selector alias', async () => command({ type: 'desktop:browse:type_selector', selector: '#selectorInput', text: 'alias selector typed' }));
  await step('browse click selector alias', async () => command({ type: 'desktop:browse:click_selector', selector: '#selectorBtn' }));
  await step('browse selector verify alias', async () => {
    const result = await command({ type: 'desktop:browse:evaluate', script: 'window.__smokeSummary()' });
    const summary = typeof result.result === 'string' ? JSON.parse(result.result) : result.result;
    assert(summary.state.selectorClicks >= 1, 'alias selector click did not register');
    assert(summary.state.typed.some((item) => item.includes('alias selector typed')), 'alias selector type did not register');
    return summary;
  });
  const refs = await step('browse snapshot refs alias', async () => {
    const result = await command({ type: 'desktop:browse:snapshot', filter: 'all', format: 'json' });
    const elements = flattenSnapshot(result.snapshot);
    const exact = await command({
      type: 'desktop:browse:evaluate',
      script: `(() => ({
        inputRef: document.querySelector('#refInput')?.getAttribute('data-empir3-ref'),
        buttonRef: document.querySelector('#refBtn')?.getAttribute('data-empir3-ref')
      }))()`,
    });
    const refs = typeof exact.result === 'string' ? JSON.parse(exact.result) : exact.result;
    assert(refs?.inputRef && refs?.buttonRef, `missing exact refs after snapshot: ${JSON.stringify(compact({ refs, elements: elements.slice(0, 12) }))}`);
    return { inputRef: refs.inputRef, buttonRef: refs.buttonRef, count: elements.length };
  });
  if (refs) {
    await step('browse type ref alias', async () => command({ type: 'desktop:browse:type_ref', ref: refs.inputRef, text: 'alias ref typed' }));
    await step('browse click ref alias', async () => command({ type: 'desktop:browse:click_ref', ref: refs.buttonRef }));
    await step('browse ref verify alias', async () => {
      const result = await command({ type: 'desktop:browse:evaluate', script: 'window.__smokeSummary()' });
      const summary = typeof result.result === 'string' ? JSON.parse(result.result) : result.result;
      assert(summary.state.refClicks >= 1, 'alias ref click did not register');
      assert(summary.state.typed.some((item) => item.includes('alias ref typed')), 'alias ref type did not register');
      return summary;
    });
  }
  await step('browse screenshot alias bytes', async () => {
    const result = await command({ type: 'desktop:browse:screenshot', quality: 65 });
    assert(result.base64 && result.mimeType === 'image/jpeg' && result.bytes > 1000, `bad screenshot shape: ${JSON.stringify(compact(result))}`);
    return { mimeType: result.mimeType, bytes: result.bytes };
  });
  await step('browse text alias', async () => command({ type: 'desktop:browse:text' }));
  await step('browse press alias', async () => command({ type: 'desktop:browse:press', key: 'Tab' }));
  await step('browse scroll alias', async () => command({ type: 'desktop:browse:scroll', amount: 300 }));
  await step('browse highlight alias', async () => command({ type: 'desktop:browse:highlight', selector: '#highlightMe' }));
  await step('browse chat alias', async () => command({ type: 'desktop:browse:chat', message: `Visible live smoke chat ${STAMP}` }));
  await step('browse read_chat alias', async () => command({ type: 'desktop:browse:read_chat' }));

  let recordingName = '';
  await step('browse record start alias', async () => command({ type: 'desktop:browse:record_start', name: `live-smoke-${STAMP}` }));
  await step('browse record action click', async () => command({ type: 'desktop:browse:click_selector', selector: '#recordBtn' }));
  await wait(700);
  await step('browse record stop alias', async () => {
    const result = await command({ type: 'desktop:browse:record_stop', name: `live-smoke-${STAMP}` });
    recordingName = result.saved || `live-smoke-${STAMP}.json`;
    assert(result.actionCount >= 1, `recording captured no actions: ${JSON.stringify(result)}`);
    return result;
  });
  await step('browse recordings alias', async () => command({ type: 'desktop:browse:recordings' }));
  if (recordingName) {
    await step('browse play alias', async () => command({ type: 'desktop:browse:play', recording: recordingName, speed: 2 }));
    await step('browser delete recording direct', async () => command({ type: 'delete_recording', recording: recordingName }));
  }
  await step('agent-browser close alias', async () => command({ type: 'desktop:agent-browser:close' }));
}

async function companionSmoke() {
  await step('capabilities quick', async () => command({ type: 'desktop:capabilities:quick' }, 60000));
  await step('capabilities full scan', async () => command({ type: 'desktop:capabilities:scan' }, 90000));
  await step('capabilities check_cli node', async () => {
    const result = await command({ type: 'desktop:capabilities:check_cli', name: 'node' });
    assert(result?.name === 'node' || result?.success, 'check_cli node did not return success');
    return result;
  });
  for (const query of ['overview', 'processes', 'disk', 'network', 'battery', 'installed']) {
    await step(`sysinfo ${query}`, async () => command({ type: `desktop:sysinfo:${query}` }, query === 'installed' ? 90000 : 45000));
  }

  let originalClipboard = null;
  await step('clipboard read backup', async () => {
    const result = await command({ type: 'desktop:clipboard:read' });
    originalClipboard = result.text || '';
    return { length: result.length || 0 };
  });
  try {
    await step('clipboard write', async () => command({ type: 'desktop:clipboard:write', text: `Empir3 live smoke ${STAMP}` }));
    await step('clipboard read verify', async () => {
      const result = await command({ type: 'desktop:clipboard:read' });
      assert((result.text || '').includes('Empir3 live smoke'), 'clipboard did not contain smoke text');
      return { length: result.length };
    });
    await step('clipboard clear', async () => command({ type: 'desktop:clipboard:clear' }));
  } finally {
    await step('clipboard restore', async () => {
      if (originalClipboard) return command({ type: 'desktop:clipboard:write', text: originalClipboard });
      return command({ type: 'desktop:clipboard:clear' });
    });
  }

  await step('execute powershell', async () => {
    const result = await command({ type: 'desktop:execute:run', command: 'Write-Output "empir3-powershell-smoke"', shell: 'powershell', timeout: 10 });
    assert(/empir3-powershell-smoke/.test(result.stdout || ''), 'powershell stdout mismatch');
    return result;
  });
  await step('execute cmd', async () => {
    const result = await command({ type: 'desktop:execute:run', command: 'echo empir3-cmd-smoke', shell: 'cmd', timeout: 10 });
    assert(/empir3-cmd-smoke/.test(result.stdout || ''), 'cmd stdout mismatch');
    return result;
  });
  await step('execute timeout handling', async () => {
    const result = await commandAllowFailure({ type: 'desktop:execute:run', command: 'Start-Sleep -Seconds 3', shell: 'powershell', timeout: 1 }, 10000);
    const body = result?.result || result;
    assert(result.ok && body.timedOut === true && body.exitCode === -2, `timeout did not report correctly: ${JSON.stringify(compact(result))}`);
    return body;
  });
  await step('execute destructive blocklist', async () => {
    const result = await commandAllowFailure({ type: 'desktop:execute:run', command: 'Remove-Item -Recurse -Force C:\\', shell: 'powershell', timeout: 5 }, 10000);
    const body = result?.result || result;
    assert(result.ok && body.blocked === true, `destructive command was not blocked: ${JSON.stringify(compact(result))}`);
    return body;
  });

  await step('notify toast visible', async () => command({ type: 'desktop:notify:show', title: 'Empir3 Bridge Smoke', message: `Visible toast from live smoke ${STAMP}` }));

  const fileText = `Empir3 live smoke file ${STAMP}`;
  let pushedPath = '';
  await step('file push', async () => {
    const result = await command({
      type: 'desktop:file',
      action: 'push',
      filename: 'empir3-live-smoke.txt',
      subfolder: 'live-smoke',
      data: Buffer.from(fileText, 'utf8').toString('base64'),
    });
    pushedPath = result.savedPath;
    return result;
  });
  await step('file pull', async () => {
    const result = await command({ type: 'desktop:file:pull', path: pushedPath, maxSizeMB: 1 });
    assert(Buffer.from(result.data, 'base64').toString('utf8') === fileText, 'pulled file content mismatch');
    return { filename: result.filename, sizeBytes: result.sizeBytes, sourcePath: result.sourcePath };
  });
  await step('project file write', async () => command({ type: 'desktop:project:file', projectName: 'live-smoke', path: 'project-file.txt', content: fileText }));
  await step('sync push text', async () => command({ type: 'desktop:sync:push', projectName: 'live-smoke', path: 'sync-file.txt', content: fileText }));
  await step('sync push base64', async () => command({ type: 'desktop:sync:push', projectName: 'live-smoke', path: 'sync-file-b64.txt', content: Buffer.from(fileText).toString('base64'), encoding: 'base64' }));
  await step('sync complete', async () => command({ type: 'desktop:sync:complete', totalPushed: 2 }));
}

async function launchNotepad(label) {
  const before = await command({ type: 'desktop:app:is_running', name: 'notepad' });
  const beforeIds = new Set((before.processes || []).map((item) => Number(item.pid)));
  await command({ type: 'desktop:app:launch', name: 'notepad' });
  await wait(1800);
  let after = null;
  for (let i = 0; i < 12; i++) {
    after = await command({ type: 'desktop:app:is_running', name: 'notepad' });
    const newProc = (after.processes || []).find((item) => !beforeIds.has(Number(item.pid)));
    if (newProc) {
      const listed = await command({ type: 'desktop:window:list', title: 'Notepad' });
      const win = (listed.windows || [])[0];
      return { label, pid: Number(newProc.pid), title: win?.title || 'Notepad', window: win };
    }
    await wait(700);
  }
  throw new Error(`Notepad did not launch: ${JSON.stringify(after)}`);
}

async function desktopSmoke() {
  await step('app is_running explorer', async () => command({ type: 'desktop:app:is_running', name: 'explorer' }));
  await step('app list_running', async () => command({ type: 'desktop:app:list_running' }, 60000));
  await step('window list', async () => command({ type: 'desktop:window:list' }));
  await step('window active', async () => command({ type: 'desktop:window:active' }));
  await step('gui monitors', async () => command({ type: 'desktop:gui:monitors' }));
  await step('gui screenshot primary', async () => {
    const result = await command({ type: 'desktop:gui:screenshot', monitor: 'primary', quality: 65 }, 90000);
    assert(result.bytes > 1000 || result.savedPath, 'desktop gui screenshot missing bytes/path');
    return result;
  });
  await step('desktop monitors direct', async () => command({ type: 'desktop_monitors' }));
  await step('desktop screenshot direct', async () => command({ type: 'desktop_screenshot', monitor: 'primary' }, 90000));
  await step('desktop cursor position direct', async () => command({ type: 'desktop_cursor_position' }));
  await step('desktop screen size direct', async () => command({ type: 'desktop_screen_size' }));
  await step('gui cursor position relay', async () => command({ type: 'desktop:gui:position' }));
  await step('gui screen size relay', async () => command({ type: 'desktop:gui:screensize' }));

  const blank = await step('app launch notepad for window close', async () => launchNotepad('blank close'), { fatal: true });
  if (blank) {
    await step('window focus', async () => command({ type: 'desktop:window:focus', title: blank.title }));
    await step('window minimize', async () => command({ type: 'desktop:window:minimize', title: blank.title }));
    await wait(500);
    await step('window restore', async () => command({ type: 'desktop:window:restore', title: blank.title }));
    await step('window maximize', async () => command({ type: 'desktop:window:maximize', title: blank.title }));
    await wait(500);
    await step('window resize', async () => command({ type: 'desktop:window:resize', title: blank.title, x: 120, y: 120, width: 820, height: 520 }));
    await step('window close blank notepad', async () => command({ type: 'desktop:window:close', title: blank.title }));
    await wait(1000);
  }

  const active = await step('app launch notepad for gui tests', async () => launchNotepad('gui'), { fatal: true });
  if (!active) return null;
  await step('window focus gui notepad', async () => command({ type: 'desktop:window:focus', title: active.title }));
  await step('window resize gui notepad', async () => command({ type: 'desktop:window:resize', title: active.title, x: 160, y: 160, width: 880, height: 540 }));
  await wait(700);
  const listed = await command({ type: 'desktop:window:list', title: 'Notepad' });
  const win = (listed.windows || [])[0] || active.window || { left: 160, top: 160, width: 880, height: 540 };
  const x = Math.round(Number(win.left) + Math.min(380, Number(win.width) / 2));
  const y = Math.round(Number(win.top) + Math.min(220, Number(win.height) / 2));
  report.artifacts.notepadTarget = { pid: active.pid, title: active.title, x, y, window: compact(win) };
  writeReport();

  await step('desktop hover direct on notepad', async () => command({ type: 'desktop_hover', x, y }));
  await step('desktop click direct on notepad', async () => command({ type: 'desktop_click', x, y, button: 'left' }));
  await step('gui type into notepad', async () => command({ type: 'desktop:gui:type', text: `Empir3 live GUI smoke ${STAMP}` }));
  await step('gui hotkey select all', async () => command({ type: 'desktop:gui:hotkey', keys: ['Control', 'a'] }));
  await step('gui type replace text', async () => command({ type: 'desktop:gui:type', text: `Empir3 live GUI replacement ${STAMP}` }));
  await step('gui move cursor', async () => command({ type: 'desktop:gui:move', x: x + 80, y: y + 40 }));
  await step('gui click', async () => command({ type: 'desktop:gui:click', x, y }));
  await step('gui doubleclick', async () => command({ type: 'desktop:gui:doubleclick', x: x + 40, y }));
  await step('gui scroll', async () => command({ type: 'desktop:gui:scroll', x, y, clicks: -1 }));
  await step('desktop drag direct on notepad', async () => command({ type: 'desktop_drag', x, y, toX: x + 140, toY: y, durationMs: 450, steps: 12 }));

  return { pid: active.pid, title: active.title, x, y };
}

async function mcpSmoke(desktopTarget) {
  if (!existsSync(INSTALLER)) throw new Error(`Installer not found for MCP smoke: ${INSTALLER}`);
  const transport = new StdioClientTransport({
    command: INSTALLER,
    args: ['--mcp'],
    env: { ...process.env, BRIDGE_URL: BRIDGE },
  });
  const client = new Client({ name: 'empir3-live-smoke', version: '1.0.0' });
  await client.connect(transport);
  const calls = [];
  async function call(name, args = {}) {
    const started = Date.now();
    try {
      const result = await client.callTool({ name, arguments: args });
      if (result?.isError) throw new Error(JSON.stringify(compact(result)));
      calls.push({ name, ok: true, elapsedMs: Date.now() - started, detail: compact(result) });
      return result;
    } catch (error) {
      calls.push({ name, ok: false, elapsedMs: Date.now() - started, error: error?.message || String(error) });
      throw error;
    }
  }

  try {
    await step('mcp list tools', async () => {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name).sort();
      const expected = [
        'browser_status', 'bridge_reliability_status', 'bridge_reliability_smoke', 'bridge_action_log',
        'bridge_safety_status', 'bridge_revoke_control',
        'browser_navigate', 'browser_click', 'browser_click_ref', 'browser_click_xy',
        'browser_type', 'browser_type_ref', 'browser_press', 'browser_scroll',
        'browser_screenshot', 'desktop_monitors', 'desktop_cursor_position', 'desktop_screenshot', 'desktop_click',
        'desktop_hover', 'desktop_drag', 'browser_snapshot', 'browser_text', 'browser_evaluate',
        'browser_highlight', 'browser_chat', 'browser_read_chat', 'browser_record_start',
        'browser_record_stop', 'browser_play', 'browser_recordings', 'browser_refresh',
      ];
      const missing = expected.filter((name) => !names.includes(name));
      assert(missing.length === 0, `missing MCP tools: ${missing.join(', ')}`);
      return { count: names.length, names };
    });

    const url = dataUrl(liveTestHtml('mcp stdio tools'));
    await step('mcp browser tools', async () => {
      await call('browser_status');
      await call('browser_navigate', { url });
      await wait(1000);
      await call('browser_snapshot', { filter: 'all' });
      await call('browser_text');
      await call('browser_type', { selector: '#mcpInput', text: 'mcp selector typed' });
      await call('browser_click', { selector: '#selectorBtn' });
      await call('browser_press', { key: 'Tab' });
      await call('browser_click_xy', { x: 120, y: 120 });
      await call('browser_scroll', { y: 260, x: 0 });
      await call('browser_evaluate', { script: 'window.__smokeSummary()' });
      await call('browser_highlight', { selector: '#highlightMe' });
      await call('browser_screenshot');
      await call('browser_chat', { message: `MCP visible smoke chat ${STAMP}` });
      await call('browser_read_chat', { limit: 10 });
      await call('browser_record_start');
      await call('browser_click', { selector: '#recordBtn' });
      const stopped = await call('browser_record_stop', { name: `mcp-live-smoke-${STAMP}` });
      await call('browser_recordings');
      await call('browser_refresh');
      return { calls: calls.filter((item) => item.name.startsWith('browser_')), stopped: compact(stopped) };
    });

    await step('mcp desktop tools', async () => {
      await call('desktop_monitors');
      await call('desktop_cursor_position');
      await call('desktop_screenshot', { monitor: 'primary' });
      if (desktopTarget?.x && desktopTarget?.y) {
        await call('desktop_hover', { x: desktopTarget.x, y: desktopTarget.y });
        await call('desktop_click', { x: desktopTarget.x, y: desktopTarget.y, button: 'left' });
        await call('desktop_drag', {
          x: desktopTarget.x,
          y: desktopTarget.y,
          toX: desktopTarget.x + 120,
          toY: desktopTarget.y,
          durationMs: 350,
          steps: 8,
          button: 'left',
        });
      }
      return { calls: calls.filter((item) => item.name.startsWith('desktop_')) };
    });

    await step('mcp reliability and safety tools', async () => {
      await call('bridge_reliability_status');
      await call('bridge_reliability_smoke');
      await call('bridge_action_log');
      await call('bridge_safety_status');
      return { calls: calls.filter((item) => item.name.startsWith('bridge_')) };
    });
  } finally {
    await client.close().catch(() => {});
  }
}

async function safetyLockdownRestoreSmoke() {
  await step('safety status before lockdown', async () => getJson('/api/safety'));
  const configBefore = await step('config backup before lockdown', async () => getJson('/api/config'));
  if (!configBefore?.enabledTools) throw new Error('Cannot run lockdown restore smoke without enabledTools backup');
  await step('safety lockdown command', async () => command({ type: 'safety_lockdown' }));
  await step('safety restore config', async () => postJson('/api/config', { enabledTools: configBefore.enabledTools }));
  await step('safety status after restore', async () => {
    const status = await getJson('/api/safety');
    assert(status.state === 'write_controls_enabled', `write controls did not restore: ${JSON.stringify(status)}`);
    return status;
  });
}

async function cleanupNotepad(target) {
  if (!target?.pid) return;
  await step('app kill smoke notepad by pid', async () => command({ type: 'desktop:app:kill', pid: target.pid }));
}

async function main() {
  writeReport();
  await step('bridge api status and provenance', async () => {
    const status = await getJson('/api/status');
    assert(status.running === true, 'bridge status is not running');
    assert(status.version === EXPECTED_VERSION, `expected bridge ${EXPECTED_VERSION}, got ${status.version}`);
    return { status, provenance: listenerProvenance() };
  }, { fatal: true });
  await step('bridge wrapper health', async () => {
    const status = await getJson('/api/status');
    const healthUrl = String(status.bridgeUrl || 'http://localhost:9867').replace('localhost', '127.0.0.1') + '/health';
    const health = await requestJson('GET', healthUrl, undefined, 15000);
    assert(health.status === 'connected' || health.ok || health.ready, `unexpected wrapper health: ${JSON.stringify(health)}`);
    return health;
  });
  await browserDirectSmoke();
  await browserAliasSmoke();
  await companionSmoke();
  const desktopTarget = await desktopSmoke();
  await mcpSmoke(desktopTarget);
  await cleanupNotepad(desktopTarget);
  await safetyLockdownRestoreSmoke();
  await step('action log available', async () => command({ type: 'action_log' }));
  await step('reliability status final', async () => command({ type: 'reliability_status' }));
  await step('reliability smoke final', async () => {
    const result = await command({ type: 'reliability_smoke' }, 90000);
    assert(result.ok === true || (Array.isArray(result.checks) && result.checks.every((check) => check.ok)), 'reliability smoke reported failure');
    return result;
  });
  writeReport();
  const failed = report.checks.filter((check) => !check.ok);
  log(`summary: ${report.checks.length - failed.length}/${report.checks.length} passed`);
  log(`report: ${REPORT_PATH}`);
  log(`summary: ${SUMMARY_PATH}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  report.fatal = error?.stack || error?.message || String(error);
  writeReport();
  console.error(report.fatal);
  process.exit(1);
});
