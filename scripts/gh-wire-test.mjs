// Wire-level smoke for the empir3-channel GitHub route.
//
// Spins an isolated bridge server (tsx src/server.ts) on an alt port pointed at
// a LOCAL mock empir3 WS server (this file). The mock drives github:probe +
// github:exec exactly as empir3-server would, and verifies the bridge's
// handleEmpir3Message route replies (github:probe:result / github:exec:result)
// with real gh. Does NOT touch the installed daemon, prod, or Chrome.
//
// Run from the bridge repo:  node scripts/gh-wire-test.mjs
import { WebSocketServer } from 'ws';
import { spawn, execSync } from 'node:child_process';

const WS_PORT = 4599;
const PW_PORT = 3199;
let pass = 0, fail = 0, child = null, done = false;
const ok = (c, m, x) => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${x ? `  → ${x}` : ''}`); };

const wss = new WebSocketServer({ host: '127.0.0.1', port: WS_PORT });
console.log(`[mock-empir3] listening on ws://127.0.0.1:${WS_PORT}`);

function cleanup(code) {
  if (done) return; done = true;
  try { if (child?.pid) execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  try { wss.close(); } catch {}
  console.log(`\n${fail === 0 ? '✅' : '❌'} wire route: ${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(code ?? (fail === 0 ? 0 : 1)), 300);
}
const hardTimer = setTimeout(() => { console.log('[mock-empir3] overall timeout'); fail++; cleanup(1); }, 60_000);

wss.on('connection', (ws, req) => {
  console.log(`[mock-empir3] bridge connected: ${req.url}`);
  const waiters = new Map();                       // id -> resolve
  const reply = (type, id) => new Promise((res) => { waiters.set(`${type}:${id}`, res); });

  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    const p = msg.payload || {};
    // Resolve any waiter keyed by replytype:id
    if (msg.type && p.id != null) {
      const w = waiters.get(`${msg.type}:${p.id}`);
      if (w) { waiters.delete(`${msg.type}:${p.id}`); w(p); }
    }
  });

  const send = (type, payload) => ws.send(JSON.stringify({ type, payload }));

  (async () => {
    await new Promise(r => setTimeout(r, 1500));   // let the bridge finish its init announces

    // 1) probe
    const probeP = reply('github:probe:result', 'p1');
    send('github:probe', { id: 'p1' });
    const probe = await Promise.race([probeP, new Promise(r => setTimeout(() => r(null), 8000))]);
    if (!probe) { ok(false, 'github:probe round-trip (no reply)'); }
    else {
      ok(probe.available === true, 'github:probe:result available', `path=${probe.path}`);
      ok(probe.authenticated === true && !!probe.account, 'github:probe:result authed', `account=${probe.account}`);
      ok(probe.device_opted_in === true, 'github:probe:result device_opted_in (lend ON)', String(probe.device_opted_in));
      ok(!!probe.scopes && probe.scopes.read === true, 'github:probe:result scope matrix', JSON.stringify(probe.scopes));
    }

    // 2) exec: gh --version (read)
    const verP = reply('github:exec:result', 'e1');
    send('github:exec', { id: 'e1', args: ['--version'], timeout_sec: 60 });
    const ver = await Promise.race([verP, new Promise(r => setTimeout(() => r(null), 15000))]);
    ok(ver && ver.success === true && /gh version/i.test(ver.stdout || ''), 'github:exec gh --version round-trip', ver ? (ver.stdout || '').split('\n')[0] : 'no reply');
    ok(ver && ver.scope === 'read' && ver.exitCode === 0, 'github:exec --version → read, exit 0');

    // 3) exec: real API call (read)
    const repoP = reply('github:exec:result', 'e2');
    send('github:exec', { id: 'e2', args: ['repo', 'list', '--limit', '3'], timeout_sec: 60 });
    const repo = await Promise.race([repoP, new Promise(r => setTimeout(() => r(null), 20000))]);
    ok(repo && repo.success === true && repo.scope === 'read', 'github:exec gh repo list (real API) round-trip', repo ? `exit ${repo.exitCode}` : 'no reply');
    if (repo?.stdout) console.log('   repo list head:', repo.stdout.split('\n').slice(0, 2).join(' | ').slice(0, 140));

    // 4) exec: scope_disabled (admin off) — comes back as a normal result, success:false
    const secP = reply('github:exec:result', 'e3');
    send('github:exec', { id: 'e3', args: ['secret', 'list'], timeout_sec: 60 });
    const sec = await Promise.race([secP, new Promise(r => setTimeout(() => r(null), 10000))]);
    ok(sec && sec.success === false && sec.stage === 'scope_disabled' && sec.scope === 'admin',
       'github:exec secret list → scope_disabled:admin', sec ? `stage=${sec.stage}` : 'no reply');

    // 5) exec: hard-blocked
    const tokP = reply('github:exec:result', 'e4');
    send('github:exec', { id: 'e4', args: ['auth', 'token'], timeout_sec: 60 });
    const tok = await Promise.race([tokP, new Promise(r => setTimeout(() => r(null), 10000))]);
    ok(tok && tok.success === false && tok.stage === 'blocked', 'github:exec auth token → blocked', tok ? tok.error?.slice(0, 50) : 'no reply');

    clearTimeout(hardTimer);
    cleanup();
  })().catch((e) => { console.error('[mock-empir3] driver error:', e); fail++; cleanup(1); });
});

// ── spawn the isolated bridge server pointed at the mock ──
const env = {
  ...process.env,
  PW_PORT: String(PW_PORT),                          // avoid the daemon's :3006
  EMPIR3_BRIDGE_PORT: '9967',                         // avoid the daemon's :9867
  EMPIR3_WS_URL: `ws://127.0.0.1:${WS_PORT}`,         // override → connect to mock, NOT prod
  EMPIR3_AUTH_TOKEN: 'gh-wire-test-token',
  EMPIR3_SERVER: `http://127.0.0.1:${PW_PORT}`,       // keep version-manifest fetch off prod
};
console.log('[mock-empir3] spawning isolated bridge: npx tsx src/server.ts (PW_PORT=' + PW_PORT + ')');
child = spawn('npx', ['tsx', 'src/server.ts'], { env, cwd: process.cwd(), shell: true });
child.stdout.on('data', d => process.stdout.write(`[bridge] ${d}`));
child.stderr.on('data', d => process.stderr.write(`[bridge:err] ${d}`));
child.on('exit', (c) => { if (!done) { console.log(`[bridge] exited early code=${c}`); fail++; cleanup(1); } });
