#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverSource = readFileSync(resolve(root, 'src/server.ts'), 'utf8');
const bridgeUrl = process.env.BRIDGE_SMOKE_URL || '';

const staticNeedles = [
  'desktop:app',
  'desktop:clipboard',
  'desktop:execute',
  'desktop:notify',
  'desktop:file',
  'desktop:file:pull',
  'desktop:project:file',
  'desktop:sync:push',
  'desktop:capabilities',
  'desktop:sysinfo',
  'desktop:window',
  'desktop:gui',
  'desktop:agent-browser',
  'desktop:browse',
  'click_ref',
  'type_ref',
  'click_selector',
  'type_selector',
  'read_chat',
  'recordings',
  'desktop_cursor_position',
];

const failures = [];
for (const needle of staticNeedles) {
  if (!serverSource.includes(needle)) failures.push(`missing static surface: ${needle}`);
}

async function postCommand(cmd) {
  const res = await fetch(`${bridgeUrl}/api/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    return { ok: false, status: res.status, body };
  }
  return { ok: true, result: body.result };
}

if (bridgeUrl) {
  const requireCommand = async (label, cmd) => {
    const r = await postCommand(cmd);
    const text = JSON.stringify(r);
    if (!r.ok) failures.push(`${label}: HTTP command failed ${text}`);
    else if (/Unknown command|Unsupported desktop message|Unsupported .* action/i.test(text)) failures.push(`${label}: unsupported ${text}`);
    return r.ok ? r.result : null;
  };

  const liveCommands = [
    { label: 'capabilities quick', cmd: { type: 'desktop:capabilities:quick' } },
    { label: 'capabilities check_cli', cmd: { type: 'desktop:capabilities:check_cli', name: 'node' } },
    { label: 'sysinfo overview', cmd: { type: 'desktop:sysinfo:overview' } },
    { label: 'sysinfo battery', cmd: { type: 'desktop:sysinfo:battery' } },
    { label: 'sysinfo installed', cmd: { type: 'desktop:sysinfo:installed' } },
    { label: 'window list', cmd: { type: 'desktop:window:list' } },
    { label: 'window active', cmd: { type: 'desktop:window:active' } },
    { label: 'gui monitors', cmd: { type: 'desktop:gui:monitors' } },
    { label: 'gui position', cmd: { type: 'desktop:gui:position' } },
    { label: 'gui screensize', cmd: { type: 'desktop:gui:screensize' } },
    { label: 'app is_running', cmd: { type: 'desktop:app:is_running', name: 'explorer' } },
    { label: 'browser status alias', cmd: { type: 'desktop:browse:status' } },
    { label: 'browser recordings alias', cmd: { type: 'desktop:agent-browser:recordings' } },
    { label: 'mcp cursor position', cmd: { type: 'desktop_cursor_position' } },
  ];

  for (const { label, cmd } of liveCommands) {
    await requireCommand(label, cmd);
  }

  if (process.env.BRIDGE_SMOKE_BROWSER === '1') {
    const html = '<!doctype html><html><body><label>Name <input id="name" aria-label="Name"></label><button id="go">Go</button><output id="out"></output><script>document.getElementById("go").onclick=()=>{document.getElementById("out").textContent="clicked:"+document.getElementById("name").value}</script></body></html>';
    await requireCommand('browser navigate alias', { type: 'desktop:browse:navigate', url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });
    await new Promise(r => setTimeout(r, 700));
    await requireCommand('browser type_selector alias', { type: 'desktop:browse:type_selector', selector: '#name', text: 'Vincent selector' });
    await requireCommand('browser click_selector alias', { type: 'desktop:browse:click_selector', selector: '#go' });
    const selectorResult = await requireCommand('browser selector evaluate', { type: 'desktop:browse:evaluate', script: 'document.getElementById("out").textContent' });
    if (!String(selectorResult?.result || '').includes('Vincent selector')) failures.push(`browser selector round trip failed: ${JSON.stringify(selectorResult)}`);

    const screenshot = await requireCommand('browser screenshot alias', { type: 'desktop:browse:screenshot', quality: 60 });
    if (!screenshot?.base64 || screenshot?.mimeType !== 'image/jpeg' || Number(screenshot?.bytes || 0) < 1000) {
      failures.push(`browser screenshot shape invalid: ${JSON.stringify({ mimeType: screenshot?.mimeType, bytes: screenshot?.bytes })}`);
    }

    await requireCommand('browser ref navigate alias', { type: 'desktop:browse:navigate', url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });
    await new Promise(r => setTimeout(r, 700));
    const snap = await requireCommand('browser snapshot alias', { type: 'desktop:browse:snapshot', filter: 'all', format: 'json' });
    const elements = Array.isArray(snap?.snapshot) ? snap.snapshot : (snap?.snapshot?.elements || snap?.snapshot?.tree || snap?.snapshot?.nodes || []);
    const input = elements.find(e => e.role === 'input') || elements.find(e => /Name/i.test(`${e.name || ''} ${e.role || ''}`));
    const button = elements.find(e => e.role === 'button' && /Go/i.test(`${e.name || ''}`)) || elements.find(e => /Go/i.test(`${e.name || ''}`));
    if (!input?.ref || !button?.ref) failures.push(`browser refs missing: ${JSON.stringify(elements.slice(0, 5))}`);
    else {
      await requireCommand('browser type_ref alias', { type: 'desktop:browse:type_ref', ref: input.ref, text: 'Vincent ref' });
      await requireCommand('browser click_ref alias', { type: 'desktop:browse:click_ref', ref: button.ref });
      const refResult = await requireCommand('browser ref evaluate', { type: 'desktop:browse:evaluate', script: 'document.getElementById("out").textContent' });
      if (!String(refResult?.result || '').includes('Vincent ref')) failures.push(`browser ref round trip failed: ${JSON.stringify(refResult)}`);
    }
  }
}

if (failures.length) {
  console.error('Companion surface check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Companion surface check passed${bridgeUrl ? ` against ${bridgeUrl}` : ' (static)'}.`);
