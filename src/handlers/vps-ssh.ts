/**
 * Explicit VPS SSH route for a paired Empir3 Bridge.
 *
 * This is deliberately not a generic shell string. The server supplies an
 * argv array plus the owner-scoped VPS credentials; the bridge uses one
 * ephemeral key file, sends the sudo password on stdin, and deletes the key
 * in finally. Mutations are never retried through another transport.
 */
import { execFileSync, spawn } from 'child_process';
import { chmodSync, unlinkSync, writeFileSync } from 'fs';
import { registerOwnedCliProcess, terminateCliProcessTree } from '../cli-process-tree.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomInt, randomUUID } from 'crypto';

type VpsSshParams = {
  host?: string;
  port?: number;
  username?: string;
  privateKey?: string;
  sudoPassword?: string;
  argv?: string[];
  stdin?: string;
  timeoutSec?: number;
  maxOutputBytes?: number;
  wait?: boolean;
  jobId?: number;
};

type ProcessResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

const JOB_DIR = '/var/lib/empir3/exec-jobs';
const USER_RE = /^[a-z][a-z0-9_-]{1,30}$/;
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|\[[0-9a-f:]+\]|(?:\d{1,3}\.){3}\d{1,3})$/i;

export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function buildSudoRootCommand(rootCommand: string): string {
  // One sudo process is load-bearing: Ubuntu may scope a validation ticket to
  // the validating process, so validation followed by a separate
  // non-interactive sudo can reject a
  // correct password. sudo consumes the first stdin line and passes the rest
  // to the requested process unchanged.
  return `exec sudo -kS -p '' -- ${rootCommand}`;
}

function trimBytes(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const data = Buffer.from(value || '', 'utf8');
  if (data.length <= maxBytes) return { text: value || '', truncated: false };
  return { text: data.subarray(0, maxBytes).toString('utf8'), truncated: true };
}

function runProcess(file: string, args: string[], input: string, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = registerOwnedCliProcess(spawn(file, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }), 'vps-ssh');
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => { stderr += error.message; finish(null); });
    child.on('close', code => finish(code));
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateCliProcessTree(child, { signal: 'SIGTERM', reason: 'VPS SSH timeout' });
      setTimeout(() => {
        if (!settled) void terminateCliProcessTree(child, { signal: 'SIGKILL', reason: 'VPS SSH timeout force' });
      }, 1_000).unref();
    }, timeoutMs);
    child.stdin?.end(input);
  });
}

function sshExecutable(): string {
  if (process.platform === 'win32' && process.env.WINDIR) {
    return join(process.env.WINDIR, 'System32', 'OpenSSH', 'ssh.exe');
  }
  return 'ssh';
}

export function hardenPrivateKeyFile(keyPath: string): void {
  if (process.platform !== 'win32') {
    chmodSync(keyPath, 0o600);
    return;
  }
  const username = String(process.env.USERNAME || '').trim();
  const domain = String(process.env.USERDOMAIN || '').trim();
  const account = domain && username ? `${domain}\\${username}` : username;
  if (!account || /[\r\n]/.test(account)) {
    throw new Error('Unable to identify the signed-in Windows user for VPS SSH key protection.');
  }
  const windowsDir = process.env.WINDIR || 'C:\\Windows';
  try {
    // Node's mode:0o600 does not remove inherited Windows ACL entries. Windows
    // OpenSSH rejects such a key as "UNPROTECTED PRIVATE KEY FILE", so remove
    // inheritance and give only the current account read access before spawn.
    execFileSync(join(windowsDir, 'System32', 'icacls.exe'), [
      keyPath,
      '/inheritance:r',
      '/grant:r',
      `${account}:(R)`,
    ], { windowsHide: true, stdio: 'ignore' });
  } catch {
    throw new Error('Unable to secure the temporary VPS SSH key on this Windows computer.');
  }
}

function validate(params: VpsSshParams): string | null {
  if (!params.host || !HOST_RE.test(params.host)) return 'Invalid VPS SSH host.';
  const port = Number(params.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'Invalid VPS SSH port.';
  if (!params.username || !USER_RE.test(params.username) || ['root', 'daemon', 'sshd'].includes(params.username)) {
    return 'Invalid VPS SSH username.';
  }
  if (!params.privateKey || params.privateKey.length > 32768 || !/-----BEGIN (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY-----/.test(params.privateKey)) {
    return 'Invalid VPS SSH private key.';
  }
  if (!params.sudoPassword || params.sudoPassword.length > 512 || /[\r\n]/.test(params.sudoPassword)) {
    return 'Invalid VPS sudo password.';
  }
  return null;
}

async function runSsh(params: Required<Pick<VpsSshParams, 'host' | 'port' | 'username' | 'privateKey' | 'sudoPassword'>>, rootCommand: string, stdin: string, timeoutSec: number): Promise<ProcessResult> {
  const keyPath = join(tmpdir(), `empir3-vps-${randomUUID()}.key`);
  try {
    writeFileSync(keyPath, params.privateKey.replace(/\r\n/g, '\n').replace(/\n*$/, '\n'), { encoding: 'utf8', mode: 0o600 });
    hardenPrivateKeyFile(keyPath);
    const args = [
      '-i', keyPath, '-p', String(params.port),
      '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
      '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
      '-o', 'StrictHostKeyChecking=no', '-o', `UserKnownHostsFile=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
      '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1',
      '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=1',
      `${params.username}@${params.host}`,
      buildSudoRootCommand(rootCommand),
    ];
    return await runProcess(
      sshExecutable(), args, `${params.sudoPassword}\n${stdin || ''}`,
      Math.max(1, Math.min(timeoutSec, 300)) * 1000,
    );
  } finally {
    try { unlinkSync(keyPath); } catch { /* best effort after spawn/open failure */ }
  }
}

function processFailure(result: ProcessResult, maxOutput: number) {
  const out = trimBytes(result.stdout, maxOutput);
  const err = trimBytes(result.timedOut ? `SSH command timed out. ${result.stderr}` : result.stderr, maxOutput);
  const code = result.timedOut ? -1 : (result.code ?? 255);
  return {
    exited: !result.timedOut,
    exitCode: code,
    stdout: out.text,
    stderr: err.text,
    truncated: out.truncated || err.truncated,
    timedOut: result.timedOut,
    transportUncertain: result.timedOut || code === 255,
    managementState: (result.timedOut || code === 255) ? 'unavailable' : 'ready',
    transport: 'bridge-ssh',
  };
}

async function status(params: VpsSshParams, maxOutput: number) {
  const jobId = Number(params.jobId);
  if (!Number.isInteger(jobId) || jobId <= 0) return { success: false, error: 'A positive SSH job id is required.' };
  const script = [
    `d=${shellQuote(JOB_DIR)}`, `j=${jobId}`,
    `if [ -f "$d/$j.exit" ]; then printf 'exited\\n'; head -n 1 "$d/$j.exit"; head -c ${maxOutput} "$d/$j.out" | base64 -w0; printf '\\n'; head -c ${maxOutput} "$d/$j.err" | base64 -w0; printf '\\n'; rm -f "$d/$j.exit" "$d/$j.out" "$d/$j.err" "$d/$j.pid"`,
    `elif [ -f "$d/$j.pid" ] && kill -0 "$(cat "$d/$j.pid")" 2>/dev/null; then printf 'running\\n'`,
    `else printf 'missing\\n'; fi`,
  ].join('; ');
  const result = await runSsh(params as any, `/bin/bash -lc ${shellQuote(script)}`, '', 20);
  if (result.code !== 0 || result.timedOut) return { success: false, ...processFailure(result, maxOutput) };
  const lines = result.stdout.split(/\r?\n/);
  if (lines[0] === 'running') return { success: true, exited: false, pid: jobId, transport: 'bridge-ssh' };
  if (lines[0] === 'missing') return { success: true, exited: false, pid: jobId, jobNotFound: true, transport: 'bridge-ssh' };
  if (lines[0] !== 'exited' || lines.length < 4) return { success: false, error: 'Unparseable Bridge SSH job status.' };
  try {
    return {
      success: true, exited: true, exitCode: Number(lines[1]),
      stdout: Buffer.from(lines[2], 'base64').toString('utf8'),
      stderr: Buffer.from(lines[3], 'base64').toString('utf8'),
      truncated: false, timedOut: false, transport: 'bridge-ssh',
    };
  } catch {
    return { success: false, error: 'Invalid Bridge SSH job payload.' };
  }
}

export async function handleVpsSsh(action: string, raw: VpsSshParams = {}) {
  const error = validate(raw);
  if (error) return { success: false, error };
  const timeoutSec = Math.max(1, Math.min(Number(raw.timeoutSec) || 60, 300));
  const maxOutput = Math.max(1024, Math.min(Number(raw.maxOutputBytes) || 65536, 262144));
  if (action === 'status') return status(raw, maxOutput);
  if (action !== 'exec') return { success: false, error: `Unknown VPS SSH action: ${action}` };
  if (!Array.isArray(raw.argv) || raw.argv.length === 0 || raw.argv.length > 64 || raw.argv.some(item => String(item).length > 4096)) {
    return { success: false, error: 'argv must be a non-empty array of bounded strings.' };
  }
  if (raw.stdin !== undefined) {
    if (raw.wait === false) return { success: false, error: 'stdin cannot be combined with background execution.' };
    const command = raw.argv.map(item => shellQuote(String(item))).join(' ');
    const result = await runSsh(raw as any, command, String(raw.stdin).slice(0, 65536), timeoutSec);
    const shaped = processFailure(result, maxOutput);
    return { success: shaped.exitCode === 0 && !shaped.timedOut, ...shaped };
  }

  const jobId = randomInt(100_000_000, 1_000_000_000);
  const command = raw.argv.map(item => shellQuote(String(item))).join(' ');
  const launcher = `install -d -m 700 ${shellQuote(JOB_DIR)}; ( set +e; ${command}; rc=$?; printf '%s\\n' "$rc" > ${shellQuote(`${JOB_DIR}/${jobId}.exit`)} ) > ${shellQuote(`${JOB_DIR}/${jobId}.out`)} 2> ${shellQuote(`${JOB_DIR}/${jobId}.err`)} < /dev/null & printf '%s\\n' "$!" > ${shellQuote(`${JOB_DIR}/${jobId}.pid`)}; printf '${jobId}\\n'`;
  const launched = await runSsh(raw as any, `/bin/bash -lc ${shellQuote(launcher)}`, '', 20);
  if (launched.code !== 0 || launched.timedOut || launched.stdout.trim() !== String(jobId)) {
    const shaped = processFailure(launched, maxOutput);
    return { success: false, ...shaped, stderr: shaped.stderr || 'Unexpected Bridge SSH launcher output.' };
  }
  if (raw.wait === false) return { success: true, exited: false, pid: jobId, transport: 'bridge-ssh' };

  const started = Date.now();
  let interval = 500;
  while (Date.now() - started < timeoutSec * 1000) {
    const checked = await status({ ...raw, jobId }, maxOutput) as any;
    if (checked.exited || checked.jobNotFound || checked.success === false) return checked;
    await new Promise(resolve => setTimeout(resolve, interval));
    interval = Math.min(Math.round(interval * 1.5), 2000);
  }
  return { success: true, exited: false, pid: jobId, timedOut: true, transport: 'bridge-ssh' };
}
