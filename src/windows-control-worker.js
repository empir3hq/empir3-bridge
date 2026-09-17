'use strict';

const {getControlLimits} = require('./control-limits.js');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

// Private inherited pipes only: no listener, port, shell endpoint or credentials.
// Callers supply repository-owned desktop scripts, never a tool's script argument.
const WORKER = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::WriteLine('{"ready":true}')
while ($null -ne ($requestLine = [Console]::ReadLine())) {
  $request = $null
  try {
    $request = ConvertFrom-Json $requestLine
    $source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($request.script))
    $control = $request.bindings
    $timer=[Diagnostics.Stopwatch]::StartNew()
    $block=[ScriptBlock]::Create($source)
    $parseMs=$timer.ElapsedMilliseconds
    $output = & $block
    $reply = @{ id=$request.id; ok=$true; output=($output -join [Environment]::NewLine); parseMs=$parseMs; runMs=($timer.ElapsedMilliseconds-$parseMs) }
  } catch {
    $reply = @{ id=$request.id; ok=$false; error=$_.Exception.Message }
    if ($_.Exception.Data.Contains('inputMayHaveOccurred')) { $reply.inputMayHaveOccurred=[bool]$_.Exception.Data['inputMayHaveOccurred'] }
  }
  [Console]::WriteLine((ConvertTo-Json -InputObject $reply -Depth 4 -Compress))
}
`;

// PowerShell 5.1 cannot replace an existing C# type. Content-address the small
// embedded interop definitions and compile each definition once per worker.
function cacheInteropTypes(script) {
  const replacements = new Map();
  let output = script.replace(/Add-Type\b[^\r\n]*?@"\r?\n([\s\S]*?)\r?\n"@[^\r\n]*/g, (block, source) => {
    // Keep parameters on BOTH sides of the here-string inside the guard.
    // Leaving `-ErrorAction` outside made a warm worker execute it as a command.
    const names = [...source.matchAll(/public\s+(?:static\s+)?class\s+(\w+)/g)].map(m => m[1]);
    if (!names.length) return block;
    const suffix = createHash('sha256').update(source).digest('hex').slice(0, 12);
    for (const name of names) replacements.set(name, `${name}_${suffix}`);
    return `if (-not ('${names[0]}' -as [type])) {\n${block}\n}`;
  });
  for (const [name, replacement] of replacements) output = output.replace(new RegExp(`\\b${name}\\b`, 'g'), replacement);
  return output;
}

function createWindowsControlWorker(options = {}) {
  const spawnProcess = options.spawnProcess || spawn;
  let child = null, active = null, buffer = '', serial = 0, ready = false, initializing = false, startupTimer = null;
  const queue = [];
  function stop(reason = new Error('Windows control worker stopped; inspect fresh state before retrying input.')) {
    const previous = child;
    child = null;
    ready = false;
    initializing = false;
    clearTimeout(startupTimer); startupTimer = null;
    buffer = '';
    if (active) { clearTimeout(active.timer); active.reject(reason); active = null; }
    for (const task of queue.splice(0)) task.reject(reason);
    previous?.kill();
  }
  function start() {
    if (child) return;
    const proc = spawnProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Mta', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WORKER, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child = proc;
    startupTimer = setTimeout(() => stop(new Error('Windows control startup timed out; no action was dispatched.')), getControlLimits().workerStartupTimeoutMs);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      if (child !== proc) return;
      buffer += chunk;
      if (buffer.length > getControlLimits().workerResponseChars) return stop(new Error('Windows control response exceeded its size limit.'));
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (!line) continue;
        let reply;
        try { reply = JSON.parse(line); } catch { return stop(new Error('Invalid Windows control response; input was not retried.')); }
        if (reply.ready === true) {
          if (ready || initializing || active) return stop(new Error('Unexpected Windows control readiness receipt; input was not retried.'));
          if (options.initializeScript) {
            initializing = true;
            proc.stdin.write(JSON.stringify({ id: 0, script: Buffer.from(cacheInteropTypes(options.initializeScript), 'utf8').toString('base64'), bindings: {} }) + '\n');
          } else {
            ready = true; clearTimeout(startupTimer); startupTimer = null; pump();
          }
          continue;
        }
        if (initializing && reply.id === 0) {
          if (!reply.ok) return stop(new Error('Windows control initialization failed; no action was dispatched.'));
          initializing = false; ready = true; clearTimeout(startupTimer); startupTimer = null; pump();
          continue;
        }
        if (!active || reply.id !== active.id) return stop(new Error('Mismatched Windows control receipt; input was not retried.'));
        const task = active; active = null; clearTimeout(task.timer);
        if (process.env.EMPIR3_NATIVE_TIMING === '1') process.stderr.write(JSON.stringify({ nativeTiming: true, parseMs:reply.parseMs, runMs:reply.runMs })+'\n');
        if (reply.ok) {
          try { task.resolve(reply.output ? JSON.parse(reply.output) : null); }
          catch { task.reject(new Error('Windows control returned invalid JSON; inspect state before retrying.')); }
        } else {
          const error=new Error(reply.error || 'Windows control failed');
          if(typeof reply.inputMayHaveOccurred==='boolean')error.inputMayHaveOccurred=reply.inputMayHaveOccurred;
          task.reject(error);
        }
        pump();
      }
    });
    // Drain errors without retaining potentially sensitive UI/text content.
    proc.stderr.resume();
    proc.stdin.on('error', () => { if (child === proc) stop(new Error('Windows control pipe closed; input was not retried.')); });
    proc.once('error', () => { if (child === proc) stop(new Error('Windows control worker could not start.')); });
    proc.once('exit', () => { if (child === proc) stop(new Error('Windows control worker exited; inspect state before retrying input.')); });
  }
  function pump() {
    if (active || !queue.length) return;
    try { start(); } catch (error) { return stop(error); }
    if (!ready) return;
    active = queue.shift();
    active.timer = setTimeout(() => stop(new Error('Windows control timed out; the action may have been dispatched. Inspect fresh state before retrying.')), active.timeoutMs);
    child.stdin.write(JSON.stringify({ id: active.id, script: Buffer.from(cacheInteropTypes(active.script), 'utf8').toString('base64'), bindings:active.bindings }) + '\n');
  }
  function run(script, timeoutMs = getControlLimits().nativeTimeoutMs, bindings = {}) {
    if (queue.length >= getControlLimits().workerQueue) return Promise.reject(new Error('Windows control queue is full. Wait for the current action.'));
    return new Promise((resolve, reject) => { queue.push({ id: ++serial, script, timeoutMs, bindings, resolve, reject }); pump(); });
  }
  return { run, stop, status: () => ({ running: !!child, ready, pending: queue.length + (active ? 1 : 0) }) };
}

module.exports = { createWindowsControlWorker, cacheInteropTypes };
