/**
 * Empir3 Bridge CLI Client
 *
 * Drives the browser bridge from a terminal or subagent script.
 * Usage:
 *   npx tsx src/cli.ts status
 *   npx tsx src/cli.ts chat "Hello from Claude!"
 *   npx tsx src/cli.ts navigate "https://example.com"
 *   npx tsx src/cli.ts click "button.submit"          (CSS selector)
 *   npx tsx src/cli.ts click-ref "e5"                 (element ref from snapshot)
 *   npx tsx src/cli.ts click-xy 500 320               (viewport coordinates)
 *   npx tsx src/cli.ts type "input#email" "user@test.com"
 *   npx tsx src/cli.ts type-ref "e3" "user@test.com"  (type into element ref)
 *   npx tsx src/cli.ts screenshot [path]              (defaults to feedback/claude-<ts>.jpg)
 *   npx tsx src/cli.ts desktop-monitors               (physical monitor bounds)
 *   npx tsx src/cli.ts desktop-screenshot [monitor]   (all, primary, DISPLAY1...)
 *   npx tsx src/cli.ts desktop-click <x> <y> [monitor] [--double]
 *   npx tsx src/cli.ts desktop-hover <x> <y> [monitor]
 *   npx tsx src/cli.ts desktop-snapshot [--all]        (UIA enumerate refs)
 *   npx tsx src/cli.ts desktop-click-ref <ref>         (click by ref)
 *   npx tsx src/cli.ts desktop-hover-ref <ref>         (hover by ref)
 *   npx tsx src/cli.ts desktop-overlay [show|hide]     (toggle labeled-box overlay)
 *   npx tsx src/cli.ts desktop-drag <x1> <y1> <x2> <y2> [monitor]
 *   npx tsx src/cli.ts reliability-status             (health + recent action receipts)
 *   npx tsx src/cli.ts reliability-smoke              (run bridge reliability checks)
 *   npx tsx src/cli.ts smoke-plan                     (print standard bridge smoke plan)
 *   npx tsx src/cli.ts action-log                     (recent command receipts)
 *   npx tsx src/cli.ts safety-status                  (read/write control state)
 *   npx tsx src/cli.ts revoke-control                 (disable write-control tools)
 *   npx tsx src/cli.ts desktop-test                   (open safe desktop test page)
 *   npx tsx src/cli.ts evaluate "1+1"
 *   npx tsx src/cli.ts refresh
 *   npx tsx src/cli.ts highlight "div.card"
 *   npx tsx src/cli.ts snapshot                        (get interactive element refs)
 *   npx tsx src/cli.ts snapshot all                    (get full page snapshot)
 *   npx tsx src/cli.ts text                            (extract page text)
 *   npx tsx src/cli.ts read-chat [last N]
 *   npx tsx src/cli.ts read-feedback [last N]
 *   npx tsx src/cli.ts listen  (streams messages in real-time)
 *   npx tsx src/cli.ts record start
 *   npx tsx src/cli.ts record stop "Login Flow"
 *   npx tsx src/cli.ts record status
 *   npx tsx src/cli.ts play "login_flow" [speed] [EMAIL=test@test.com PASSWORD=secret]
 *   npx tsx src/cli.ts recordings  (list saved recordings)
 */

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:3006';
const BRIDGE_WS = (process.env.BRIDGE_URL ? process.env.BRIDGE_URL.replace(/^http/, 'ws') : 'ws://localhost:3006') + '?role=cli';

function readBridgeNonce(): string {
  const explicit = process.env.EMPIR3_BRIDGE_NONCE || process.env.BRIDGE_NONCE;
  if (explicit?.trim()) return explicit.trim();
  try {
    return readFileSync(join(homedir(), '.empir3-bridge', 'nonce'), 'utf-8').trim();
  } catch {
    return '';
  }
}

function bridgeHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const nonce = readBridgeNonce();
  if (nonce) headers['X-Empir3-Nonce'] = nonce;
  return headers;
}

async function api(path: string, method = 'GET', body?: any) {
  const opts: any = { method, headers: bridgeHeaders() };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BRIDGE_URL}${path}`, opts);
  if (!res.ok) {
    throw new Error(`Bridge ${path}: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function command(cmd: any) {
  const result = await api('/api/command', 'POST', { action: cmd.type, ...cmd });
  if (!result.ok) throw new Error(result.error || 'Command failed');
  return result;
}

async function main() {
  const [, , action, ...args] = process.argv;

  if (!action) {
    console.log('Usage: npx tsx src/cli.ts <command> [args...]');
    console.log('');
    console.log('Browser Control:');
    console.log('  status                          Show bridge daemon status');
    console.log('  navigate <url>                  Navigate to URL');
    console.log('  click <selector>                Click by CSS selector');
    console.log('  click-ref <ref>                 Click by element ref (e.g., e5)');
    console.log('  click-xy <x> <y>                Click viewport coordinates without DOM');
    console.log('  type <selector> <text>          Type into CSS selector');
    console.log('  type-ref <ref> <text>           Type into element ref');
    console.log('  screenshot [path]               Take screenshot (saves to path if given)');
    console.log('  desktop-monitors                Show DPI-aware physical monitor bounds');
    console.log('  desktop-screenshot [monitor]    Capture desktop monitor(s): all, primary, DISPLAY1');
    console.log('  desktop-click <x> <y> [monitor] Click desktop coordinates; monitor makes x/y monitor-relative');
    console.log('  desktop-hover <x> <y> [monitor] Move cursor to desktop coordinates');
    console.log('  desktop-snapshot [--all]        Enumerate UI elements via UI Automation; returns refs');
    console.log('  desktop-snapshot-som            SoM: numbered boxes drawn on a focus screenshot');
    console.log('  desktop-click-ref <ref>         Click by snapshot ref (e.g. d3)');
    console.log('  desktop-hover-ref <ref>         Hover by snapshot ref');
    console.log('  desktop-overlay [show|hide]     Toggle click-through labeled-box overlay');
    console.log('  desktop-select-region           User drags a rectangle → sets agent focus');
    console.log('  desktop-release-focus           Clear the agent focus region');
    console.log('  desktop-focus-status            Report current focus state');
    console.log('  desktop-drag <x1> <y1> <x2> <y2> [monitor] Drag between desktop coordinates');
    console.log('  reliability-status              Show bridge health, tools, and recent action receipts');
    console.log('  reliability-smoke               Run monitor, screenshot, and trusted click checks');
    console.log('  smoke-plan                      Print the standard bridge smoke test plan');
    console.log('  action-log                      Show recent command receipts');
    console.log('  safety-status                   Show read/write control state');
    console.log('  revoke-control                  Disable browser interact, desktop, eval, and recording tools');
    console.log('  desktop-test                    Open the safe desktop click/drag test page');
    console.log('  evaluate <js>                   Run arbitrary JavaScript in the page');
    console.log('  refresh                         Reload page');
    console.log('  highlight <selector>            Highlight element');
    console.log('  snapshot [all|interactive]       Get element refs from accessibility tree');
    console.log('  text                            Extract page text');
    console.log('');
    console.log('Chat:');
    console.log('  chat "message"                  Send message to browser overlay');
    console.log('  read-chat [N]                   Read last N chat messages');
    console.log('  read-feedback [N]               Read last N feedback items');
    console.log('  listen                          Stream messages in real-time');
    console.log('');
    console.log('Recording/Playback:');
    console.log('  record start                    Start recording user actions');
    console.log('  record stop [name]              Stop and save recording');
    console.log('  record status                   Check recording status');
    console.log('  play <name> [speed] [VAR=val]   Play a recording');
    console.log('  recordings                      List saved recordings');
    console.log('');
    console.log('Pairing:');
    console.log('  pair <code>                     Redeem a pre-authorized Empir3 pairing code (writes bridge-auth.json)');
    process.exit(0);
  }

  try {
    switch (action) {
      case 'pair': {
        // Redeem a pre-authorized Empir3 pairing code (the `--pair <code>` install
        // path), writing bridge-auth.json. Talks to Empir3 directly, not the local
        // daemon. Override the target with EMPIR3_SERVER for local-dev testing.
        const code = args[0];
        if (!code) {
          console.error('Usage: pair <code>   (set EMPIR3_SERVER to target a non-prod Empir3)');
          process.exit(1);
        }
        const { claimPairingCode } = await import('./pair-claim.js');
        const result = await claimPairingCode(code, { log: (m) => console.log(`[pair] ${m}`) });
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.ok ? 0 : 1);
        break;
      }
      case 'status': {
        const result = await api('/api/status');
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'chat': {
        const message = args.join(' ');
        if (!message) { console.error('Usage: chat "message"'); process.exit(1); }
        await command({ type: 'chat', message });
        console.log('Sent:', message);
        break;
      }

      case 'navigate': {
        const url = args[0];
        if (!url) { console.error('Usage: navigate <url>'); process.exit(1); }
        const result = await command({ type: 'navigate', url });
        console.log('Navigated to:', result.result?.url);
        break;
      }

      case 'click': {
        const selector = args[0];
        if (!selector) { console.error('Usage: click <selector>'); process.exit(1); }
        await command({ type: 'click', selector });
        console.log('Clicked:', selector);
        break;
      }

      case 'click-ref': {
        const ref = args[0];
        if (!ref) { console.error('Usage: click-ref <ref> (e.g., e5)'); process.exit(1); }
        await command({ type: 'click_ref', ref });
        console.log('Clicked ref:', ref);
        break;
      }

      case 'click-xy': {
        const x = Number(args[0]);
        const y = Number(args[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) { console.error('Usage: click-xy <x> <y>'); process.exit(1); }
        await command({ type: 'click_xy', x, y });
        console.log(`Clicked coordinates: ${x},${y}`);
        break;
      }

      case 'type': {
        const [selector, ...textParts] = args;
        const text = textParts.join(' ');
        if (!selector || !text) { console.error('Usage: type <selector> <text>'); process.exit(1); }
        await command({ type: 'type', selector, text });
        console.log('Typed into', selector);
        break;
      }

      case 'type-ref': {
        const [ref, ...textParts] = args;
        const text = textParts.join(' ');
        if (!ref || !text) { console.error('Usage: type-ref <ref> <text>'); process.exit(1); }
        await command({ type: 'type_ref', ref, text });
        console.log('Typed into ref:', ref);
        break;
      }

      case 'screenshot': {
        const destPath = args[0];
        const result = await command({ type: 'screenshot' });
        const sourcePath = result.result?.path;
        if (destPath && sourcePath) {
          // Honor explicit path arg — copy the freshly-written JPEG there.
          const { copyFileSync, mkdirSync } = await import('fs');
          const { dirname } = await import('path');
          try { mkdirSync(dirname(destPath), { recursive: true }); } catch {}
          copyFileSync(sourcePath, destPath);
          console.log('Screenshot saved:', destPath);
        } else {
          console.log('Screenshot saved:', sourcePath);
        }
        break;
      }

      case 'desktop-monitors': {
        const result = await command({ type: 'desktop_monitors' });
        console.log(JSON.stringify(result.result, null, 2));
        break;
      }

      case 'desktop-screenshot': {
        const regionArg = args.find(a => a.startsWith('--region='));
        let region: any;
        if (regionArg) {
          const parts = regionArg.split('=')[1].split(',').map(Number);
          if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) {
            console.error('Usage: --region=x,y,width,height (all integers, virtual-screen coords)');
            process.exit(1);
          }
          region = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
        }
        const gridArg = args.find(a => a === '--grid' || a.startsWith('--grid='));
        let grid: any;
        if (gridArg === '--grid') grid = true;
        else if (gridArg) {
          const stepMatch = gridArg.split('=')[1];
          const step = Number(stepMatch);
          grid = Number.isFinite(step) ? { step } : true;
        }
        const markerArg = args.find(a => a.startsWith('--marker='));
        let marker: any;
        if (markerArg) {
          const mp = markerArg.split('=')[1].split(',').map(Number);
          if (mp.length !== 2 || mp.some(n => !Number.isFinite(n))) {
            console.error('Usage: --marker=x,y (virtual-screen coords)');
            process.exit(1);
          }
          marker = { x: mp[0], y: mp[1] };
        }
        const monitor = args.find(a => !a.startsWith('--')) || 'all';
        const result = await command({ type: 'desktop_screenshot', monitor, region, grid, marker });
        console.log(JSON.stringify(result.result, null, 2));
        break;
      }

      case 'desktop-click': {
        const x = Number(args[0]);
        const y = Number(args[1]);
        const monitor = args.find(a => a && !a.startsWith('--') && a !== args[0] && a !== args[1]);
        const double = args.includes('--double');
        const buttonArg = args.find(a => a.startsWith('--button='));
        const button = buttonArg ? buttonArg.split('=')[1] : 'left';
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          console.error('Usage: desktop-click <x> <y> [monitor] [--double] [--button=left|right|middle]');
          process.exit(1);
        }
        const result = await command({
          type: 'desktop_click',
          x,
          y,
          monitor,
          space: monitor ? 'monitor' : 'desktop',
          double,
          button,
        });
        console.log(JSON.stringify(result.result, null, 2));
        break;
      }

      case 'desktop-hover': {
        const x = Number(args[0]);
        const y = Number(args[1]);
        const monitor = args.find(a => a && !a.startsWith('--') && a !== args[0] && a !== args[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          console.error('Usage: desktop-hover <x> <y> [monitor]');
          process.exit(1);
        }
        const result = await command({
          type: 'desktop_hover',
          x,
          y,
          monitor,
          space: monitor ? 'monitor' : 'desktop',
        });
        console.log(JSON.stringify(result.result, null, 2));
        break;
      }

      case 'desktop-drag': {
        const x = Number(args[0]);
        const y = Number(args[1]);
        const toX = Number(args[2]);
        const toY = Number(args[3]);
        const monitor = args.find((a, i) => i > 3 && a && !a.startsWith('--'));
        const buttonArg = args.find(a => a.startsWith('--button='));
        const durationArg = args.find(a => a.startsWith('--duration='));
        const stepsArg = args.find(a => a.startsWith('--steps='));
        const button = buttonArg ? buttonArg.split('=')[1] : 'left';
        const durationMs = durationArg ? Number(durationArg.split('=')[1]) : undefined;
        const steps = stepsArg ? Number(stepsArg.split('=')[1]) : undefined;
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(toX) || !Number.isFinite(toY)) {
          console.error('Usage: desktop-drag <x1> <y1> <x2> <y2> [monitor] [--button=left|right|middle] [--duration=500] [--steps=24]');
          process.exit(1);
        }
        const result = await command({
          type: 'desktop_drag',
          x,
          y,
          toX,
          toY,
          monitor,
          space: monitor ? 'monitor' : 'desktop',
          button,
          durationMs,
          steps,
        });
        console.log(JSON.stringify(result.result, null, 2));
        break;
      }

      case 'desktop-snapshot': {
        const scopeArg = args.find(a => a === '--all' || a === '--foreground');
        const scope = scopeArg === '--all' ? 'all-windows' : 'foreground';
        const maxArg = args.find(a => a.startsWith('--max='));
        const maxElements = maxArg ? Number(maxArg.split('=')[1]) : 200;
        const result = await command({ type: 'desktop_snapshot', scope, maxElements });
        console.log(JSON.stringify(result.result, null, 2));
        break;
      }

      case 'desktop-snapshot-som': {
        const maxArg = args.find(a => a.startsWith('--max='));
        const maxElements = maxArg ? Number(maxArg.split('=')[1]) : 200;
        const result = await command({ type: 'desktop_snapshot_som', maxElements });
        console.log(JSON.stringify(result.result, null, 2));
        break;
      }

      case 'desktop-click-ref': {
        const ref = args[0];
        const buttonArg = args.find(a => a.startsWith('--button='));
        const button = buttonArg ? buttonArg.split('=')[1] : 'left';
        const double = args.includes('--double');
        if (!ref) { console.error('Usage: desktop-click-ref <ref> [--button=left|right|middle] [--double]'); process.exit(1); }
        const result = await command({ type: 'desktop_click_ref', ref, button, double });
        console.log(JSON.stringify(result.result, null, 2));
        break;
      }

      case 'desktop-hover-ref': {
        const ref = args[0];
        if (!ref) { console.error('Usage: desktop-hover-ref <ref>'); process.exit(1); }
        const result = await command({ type: 'desktop_hover_ref', ref });
        console.log(JSON.stringify(result.result, null, 2));
        break;
      }

      case 'desktop-overlay': {
        const action = args[0] || 'toggle';
        if (!['show','hide','toggle','status'].includes(action)) {
          console.error('Usage: desktop-overlay [show|hide|toggle|status]');
          process.exit(1);
        }
        const result = await command({ type: 'desktop_overlay', action });
        console.log(JSON.stringify(result.result, null, 2));
        break;
      }

      case 'desktop-select-region': {
        const tArg = args.find(a => a.startsWith('--timeout='));
        const timeoutMs = tArg ? Number(tArg.split('=')[1]) : undefined;
        const result = await command({ type: 'desktop_select_region', timeoutMs });
        console.log(JSON.stringify(result.result, null, 2));
        break;
      }

      case 'desktop-release-focus': {
        const result = await command({ type: 'desktop_release_focus' });
        console.log(JSON.stringify(result.result, null, 2));
        break;
      }

      case 'desktop-focus-status': {
        const result = await command({ type: 'desktop_focus_status' });
        console.log(JSON.stringify(result.result, null, 2));
        break;
      }

      case 'reliability-status': {
        const result = await command({ type: 'reliability_status' });
        console.log(JSON.stringify(result.result, null, 2));
        break;
      }

      case 'reliability-smoke': {
        const result = await command({ type: 'reliability_smoke' });
        console.log(JSON.stringify(result.result, null, 2));
        break;
      }

      case 'smoke-plan': {
        const result = await api('/api/bridge-smoke-test-plan');
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'action-log': {
        const result = await command({ type: 'action_log' });
        console.log(JSON.stringify(result.result, null, 2));
        break;
      }

      case 'safety-status': {
        const result = await command({ type: 'safety_status' });
        console.log(JSON.stringify(result.result, null, 2));
        break;
      }

      case 'revoke-control': {
        const result = await command({ type: 'safety_lockdown' });
        console.log(JSON.stringify(result.result, null, 2));
        break;
      }

      case 'desktop-test': {
        const result = await command({ type: 'navigate', url: `${BRIDGE_URL}/desktop-test` });
        console.log('Opened desktop test page:', result.result?.url);
        break;
      }

      case 'evaluate': {
        const script = args.join(' ');
        if (!script) { console.error('Usage: evaluate <js>'); process.exit(1); }
        const result = await command({ type: 'evaluate', script });
        console.log(JSON.stringify(result.result?.result ?? result.result, null, 2));
        break;
      }

      case 'refresh': {
        await command({ type: 'refresh' });
        console.log('Page refreshed');
        break;
      }

      case 'highlight': {
        const selector = args[0];
        if (!selector) { console.error('Usage: highlight <selector>'); process.exit(1); }
        await command({ type: 'highlight', selector });
        console.log('Highlighted:', selector);
        break;
      }

      case 'snapshot': {
        const filter = args[0] || 'interactive';
        const format = args[1] || 'compact';
        const result = await command({ type: 'snapshot', filter, format });
        const snapshot = result.result?.snapshot;
        if (typeof snapshot === 'string') {
          // Compact format — print as-is
          console.log(snapshot);
        } else if (Array.isArray(snapshot)) {
          // JSON format — pretty print element refs
          for (const el of snapshot) {
            const bounds = el.bounds ? ` (${el.bounds.x},${el.bounds.y} ${el.bounds.width}x${el.bounds.height})` : '';
            console.log(`  ${el.ref}  [${el.role}]  "${el.name || ''}"${bounds}`);
          }
          console.log(`\n${snapshot.length} elements`);
        } else {
          console.log(JSON.stringify(snapshot, null, 2));
        }
        break;
      }

      case 'text': {
        const result = await command({ type: 'text' });
        console.log(result.result?.text || '(no text)');
        break;
      }

      case 'read-chat': {
        const limit = parseInt(args[0]) || 20;
        const messages = await api('/api/chat');
        const recent = messages.slice(-limit);
        for (const msg of recent) {
          const time = new Date(msg.timestamp).toLocaleTimeString();
          const prefix = msg.from === 'user' ? '  You' : '    Claude';
          console.log(`[${time}] ${prefix}: ${msg.text}`);
          if (msg.screenshot) console.log(`         [screenshot: ${msg.screenshot}]`);
          if (msg.selector) console.log(`         [element: ${msg.selector}]`);
        }
        if (recent.length === 0) console.log('No messages yet.');
        break;
      }

      case 'read-feedback': {
        const { readFileSync, existsSync } = await import('fs');
        const { resolve } = await import('path');
        const fbFile = resolve(__dirname, '..', 'feedback', 'feedback.jsonl');
        if (!existsSync(fbFile)) { console.log('No feedback yet.'); break; }
        const lines = readFileSync(fbFile, 'utf-8').trim().split('\n').filter(Boolean);
        const limit = parseInt(args[0]) || 10;
        const recent = lines.slice(-limit).map(l => JSON.parse(l));
        for (const entry of recent) {
          const time = new Date(entry.timestamp).toLocaleTimeString();
          console.log(`[${time}] "${entry.comment}" on ${entry.selector}`);
          if (entry.screenshotPath) console.log(`         [screenshot: ${entry.screenshotName || entry.screenshotPath}]`);
        }
        break;
      }

      case 'listen': {
        console.log('Listening for messages... (Ctrl+C to stop)\n');
        const { WebSocket } = await import('ws');
        const ws = new WebSocket(BRIDGE_WS);
        ws.on('open', () => console.log('Connected to bridge.\n'));
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          const time = new Date().toLocaleTimeString();
          if (msg.type === 'user_message') {
            console.log(`[${time}] User: ${msg.message.text}`);
            if (msg.message.screenshot) console.log(`         [screenshot: ${msg.message.screenshot}]`);
            if (msg.message.selector) console.log(`         [element: ${msg.message.selector}]`);
            if (msg.message.url) console.log(`         [url: ${msg.message.url}]`);
          } else if (msg.type === 'feedback') {
            console.log(`[${time}] Feedback: "${msg.entry.comment}" on ${msg.entry.selector}`);
          } else {
            console.log(`[${time}] Event: ${msg.type}`);
          }
        });
        ws.on('close', () => { console.log('Disconnected.'); process.exit(0); });
        await new Promise(() => {});
        break;
      }

      case 'record': {
        const subAction = args[0] || 'status';
        if (subAction === 'start') {
          const result = await command({ type: 'record_start' });
          console.log('Recording started at', result.result?.startUrl, '(engine: empir3)');
        } else if (subAction === 'stop') {
          const name = args.slice(1).join(' ') || undefined;
          const result = await command({ type: 'record_stop', text: name });
          const r = result.result;
          console.log(`Recording saved: ${r?.saved} (${r?.actionCount} actions, ${(r?.duration / 1000).toFixed(1)}s)`);
          if (r?.refCount !== undefined) console.log(`Element refs: ${r.refCount}/${r.actionCount} actions have refs`);
          if (r?.variables?.length) console.log('Variables:', r.variables.join(', '));
        } else if (subAction === 'status') {
          const result = await api('/api/recording-status');
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.error('Usage: record start | record stop [name] | record status');
        }
        break;
      }

      case 'play': {
        const recording = args[0];
        if (!recording) { console.error('Usage: play <recording-name> [speed] [VAR=value ...]'); process.exit(1); }
        const speed = parseFloat(args[1]) || 1;
        const variables: Record<string, string> = {};
        for (const arg of args.slice(2)) {
          const eq = arg.indexOf('=');
          if (eq > 0) variables[arg.slice(0, eq)] = arg.slice(eq + 1);
        }
        console.log(`Playing "${recording}" at ${speed}x speed...`);
        if (Object.keys(variables).length) console.log('Variables:', variables);
        const result = await command({ type: 'play', recording, speed, variables });
        if (result.ok) {
          const r = result.result;
          console.log(`\nDone: ${r.passed}/${r.total} steps passed, ${r.failed} failed.`);
          for (const step of r.results) {
            const icon = step.ok ? '\u2713' : '\u2717';
            const method = step.method ? ` [${step.method}]` : '';
            console.log(`  ${icon} Step ${step.step}: ${step.action}${method}${step.error ? ' \u2014 ' + step.error : ''}`);
          }
        } else {
          console.error('Playback failed:', result.error);
        }
        break;
      }

      case 'recordings': {
        const recordings = await api('/api/recordings');
        if (recordings.length === 0) { console.log('No recordings yet.'); break; }
        for (const r of recordings) {
          const engine = r.engine === 'empir3' ? ' [empir3]' : ' [legacy]';
          console.log(`  ${r.name} (${r.actionCount} actions, ${(r.duration / 1000).toFixed(1)}s)${engine} \u2014 ${r.startUrl}`);
          if (r.description) console.log(`    ${r.description}`);
          if (r.variables?.length) console.log(`    Variables: ${r.variables.join(', ')}`);
        }
        break;
      }

      default:
        console.error('Unknown command:', action);
        console.error('Run without args for help.');
        process.exit(1);
    }
  } catch (e: any) {
    if (e.cause?.code === 'ECONNREFUSED') {
      console.error('Bridge server not running. Start it with: npm start (in the bridge repo)');
    } else {
      console.error('Error:', e.message);
    }
    process.exit(1);
  }
}

main();
