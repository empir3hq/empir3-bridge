import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

type ProbeReceipt = {
  cli: string;
  exitCode: number | null;
  listed: number;
  called: number;
  markerPresent: boolean;
  stderrTail: string;
};

async function main() {
  const marker = `EMPIR3_CLI_MCP_${Date.now()}`;
  let listed = 0;
  let called = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const rpc = JSON.parse(body || '{}');
      const requests = Array.isArray(rpc) ? rpc : [rpc];
      const responses: unknown[] = [];
      for (const request of requests) {
      let result: unknown = {};
      if (request.method === 'initialize') {
        result = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'empir3-probe', version: '1.0.0' },
        };
      } else if (request.method === 'tools/list') {
        listed += 1;
        result = {
          tools: [{
            name: 'empir3_marker',
            description: 'Return the exact isolation marker. Always call this when asked for the marker.',
            inputSchema: { type: 'object', properties: {} },
          }],
        };
      } else if (request.method === 'tools/call') {
        called += 1;
        result = { content: [{ type: 'text', text: marker }] };
      }
      if (request.id != null) responses.push({ jsonrpc: '2.0', id: request.id, result });
      }
      if (responses.length === 0) {
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(Array.isArray(rpc) ? responses : responses[0]));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('probe server did not bind');
  const url = `http://127.0.0.1:${address.port}`;

  const run = async (cli: string, file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, stdin?: string): Promise<ProbeReceipt> => {
    const beforeListed = listed;
    const beforeCalled = called;
    const isCmd = /\.(cmd|bat)$/i.test(file);
    const child = spawn(isCmd ? 'cmd.exe' : file, isCmd ? ['/d', '/s', '/c', file, ...args] : args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    if (stdin != null) child.stdin.end(stdin);
    else child.stdin.end();
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${cli} probe timed out`));
      }, 90_000);
      child.once('error', reject);
      child.once('close', code => { clearTimeout(timer); resolveExit(code); });
    });
    return {
      cli,
      exitCode,
      listed: listed - beforeListed,
      called: called - beforeCalled,
      markerPresent: stdout.includes(marker),
      stderrTail: stderr.trim().slice(-300),
    };
  };

  const roots: string[] = [];
  try {
    const codexRoot = await mkdtemp(join(tmpdir(), 'empir3-codex-probe-'));
    roots.push(codexRoot);
    const codexPath = join(process.env.APPDATA || '', 'npm', 'codex.cmd');
    const codexReceipt = await run('codex', codexPath, [
      'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--sandbox', 'read-only', '--cd', codexRoot, '--skip-git-repo-check',
      '-c', `mcp_servers.empir3.url="${url}"`,
      '-c', 'mcp_servers.empir3.default_tools_approval_mode="approve"',
      '-',
    ], codexRoot, { ...process.env }, `Call the empir3_marker MCP tool, then return only its exact result.`);

    const agyRoot = await mkdtemp(join(tmpdir(), 'empir3-agy-probe-'));
    roots.push(agyRoot);
    const agyDir = join(agyRoot, '.antigravity');
    await mkdir(agyDir, { recursive: true });
    await writeFile(join(agyDir, 'settings.json'), JSON.stringify({
      mcpServers: { empir3: { url, serverUrl: url, httpUrl: url } },
    }), 'utf8');
    const agyPath = join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe');
    const agyReceipt = await run('agy', agyPath, [
      '--dangerously-skip-permissions', '--disable-slash-commands', '-p',
      'Call the empir3_marker MCP tool, then return only its exact result.',
    ], agyRoot, {
      ...process.env,
      HOME: agyRoot,
      USERPROFILE: agyRoot,
      XDG_CONFIG_HOME: join(agyRoot, '.config'),
    });

    const receipts = [codexReceipt, agyReceipt];
    const geminiPath = join(process.env.APPDATA || '', 'npm', 'gemini.cmd');
    if (existsSync(geminiPath)) {
      const geminiRoot = await mkdtemp(join(tmpdir(), 'empir3-gemini-probe-'));
      roots.push(geminiRoot);
      const geminiDir = join(geminiRoot, '.gemini');
      await mkdir(geminiDir, { recursive: true });
      for (const name of ['oauth_creds.json', 'google_accounts.json', 'installation_id']) {
        const source = join(homedir(), '.gemini', name);
        if (existsSync(source)) await copyFile(source, join(geminiDir, name));
      }
      await writeFile(join(geminiDir, 'settings.json'), JSON.stringify({
        security: { auth: { selectedType: 'oauth-personal' } },
        mcpServers: { empir3: { url, httpUrl: url } },
      }), 'utf8');
      const trustedFoldersPath = join(geminiRoot, 'trustedFolders.json');
      await writeFile(trustedFoldersPath, JSON.stringify({
        [geminiRoot.replace(/\\/g, '/').toLowerCase()]: 'TRUST_FOLDER',
      }), 'utf8');
      receipts.push(await run('gemini', geminiPath, [
        '--skip-trust', '--approval-mode', 'yolo',
        '--allowed-mcp-server-names', 'empir3',
        '-p', 'Read the full task from stdin.',
      ], geminiRoot, {
        ...process.env,
        HOME: geminiRoot,
        USERPROFILE: geminiRoot,
        XDG_CONFIG_HOME: join(geminiRoot, '.config'),
        GEMINI_CLI_TRUSTED_FOLDERS_PATH: trustedFoldersPath,
      }, 'Call the empir3_marker MCP tool, then return only its exact result.'));
    }

    console.log(JSON.stringify(receipts));
    if (receipts.some(r => r.exitCode !== 0 || r.listed < 1 || r.called < 1 || !r.markerPresent)) {
      process.exitCode = 1;
    }
  } finally {
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
