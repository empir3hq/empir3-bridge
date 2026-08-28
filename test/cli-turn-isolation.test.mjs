import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

test('Codex text, tool, and vision turns ignore owner config and use a private cwd', () => {
  const turn = server.match(/async function startCodexCliTurn[\s\S]*?function abortCodexCliTurn/)?.[0] || '';
  const vision = server.match(/async function runCodexCliSee[\s\S]*?async function runAgyCliSee/)?.[0] || '';

  assert.match(turn, /'--ignore-user-config'/);
  assert.doesNotMatch(turn, /turnTools\.length > 0 \? \['--ignore-user-config'\]/);
  assert.match(turn, /'--cd',\s*turnTempDir/);
  assert.match(turn, /cwd: turnTempDir/);
  assert.match(turn, /rmSync\(turnTempDir/);
  assert.match(turn, /env: codexCliEnv\(\)/);
  assert.match(turn, /startCliMcpShim\('codex', id, bridgeName, turnTools, emit\)/);
  assert.match(turn, /`mcp_servers\.\$\{bridgeName\}\.url=/);
  assert.match(turn, /`mcp_servers\.\$\{bridgeName\}\.tool_timeout_sec=/);
  assert.match(turn, /`mcp_servers\.\$\{bridgeName\}\.default_tools_approval_mode=/);
  assert.match(turn, /mcpShim\.attach\.onListed/);
  assert.match(turn, /stage: 'mcp_attach'/);
  assert.match(turn, /__mcp_attach_attempt: mcpAttachAttempt \+ 1/);

  assert.match(vision, /'--ignore-user-config'/);
  assert.match(vision, /unsetEnv: \['OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY'\]/);
  assert.match(vision, /'--cd', tempDir/);
  assert.match(vision, /cwd: tempDir/);
});

test('PTY no-tools turns run the same per-turn isolation setup as tool turns', () => {
  const baseSpec = server.match(/interface BaseCliTurnSpec[\s\S]*?\n\}/)?.[0] || '';
  const runner = server.match(/async function startPtyCliTurn[\s\S]*?function abortPtyCliTurn/)?.[0] || '';

  assert.match(baseSpec, /noToolsSetup\?/);
  assert.match(runner, /else if \(spec\.noToolsSetup\)/);
  assert.match(runner, /mcpHandle = await spec\.noToolsSetup\(id, bridgeName\)/);
});

test('AGY preserves auth receipts but isolates home config, MCPs, plugins, and skills', () => {
  const setup = server.match(/async function agyMcpSetup[\s\S]*?const AGY_PTY_CLI_SPEC/)?.[0] || '';
  const spec = server.match(/const AGY_PTY_CLI_SPEC[\s\S]*?async function handleAgyCliCommand/)?.[0] || '';

  assert.match(setup, /copyTurnAuthFile\(tempDir, \['\.config', 'agy', 'credentials\.json'\]\)/);
  assert.match(setup, /copyTurnAuthFile\(tempDir, \['\.antigravity', 'credentials\.json'\]\)/);
  assert.match(setup, /mcpServers: shimUrl \?/);
  assert.match(setup, /env: isolatedCliHomeEnv\(tempDir\)/);
  assert.match(spec, /'--disable-slash-commands'/);
  assert.match(spec, /unsetEnv: \['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'\]/);
  assert.match(spec, /noToolsSetup: \(turnId, bridgeName\) => agyMcpSetup\(turnId, bridgeName, ''\)/);
});

test('Gemini turns and vision copy auth only into an isolated home', () => {
  const setup = server.match(/async function populateGeminiTurnHome[\s\S]*?const GEMINI_PLAIN_CLI_SPEC/)?.[0] || '';
  const spec = server.match(/const GEMINI_PLAIN_CLI_SPEC[\s\S]*?async function handleGeminiCliCommand/)?.[0] || '';
  const vision = server.match(/async function runGeminiCliSee[\s\S]*?Generic plain-CLI turn runner/)?.[0] || '';

  assert.match(setup, /copyTurnAuthFile\(tempDir, \['\.gemini', 'oauth_creds\.json'\]\)/);
  assert.match(setup, /mcpServers: shimUrl \?/);
  assert.match(setup, /isolatedCliHomeEnv\(tempDir\)/);
  assert.match(spec, /noToolsSetup: \(turnId, bridgeName\) => geminiMcpSetup\(turnId, bridgeName, ''\)/);
  assert.match(spec, /unsetEnv: \['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'\]/);
  assert.match(vision, /populateGeminiTurnHome\(tempDir, 'empir3-vision', ''\)/);
  assert.match(vision, /isolatedCliHomeEnv\(tempDir\)/);
});

test('direct cli_run and Grok Verify cannot bypass provider isolation', () => {
  const cliRun = server.match(/async function cliRun[\s\S]*?type GrokAuthVerificationResult/)?.[0] || '';
  const grokVerify = server.match(/async function verifyGrokAuthLiveOnce[\s\S]*?function cliRunsList/)?.[0] || '';

  assert.match(cliRun, /'--ephemeral', '--ignore-user-config', '--ignore-rules'/);
  assert.match(cliRun, /'--safe-mode', '--no-session-persistence', '--disable-slash-commands'/);
  assert.match(cliRun, /createGrokTurnIsolation\(id, '', \{ allowNativeTools: mode === 'agentic' \}\)/);
  assert.match(cliRun, /cliIsolation = await geminiMcpSetup\(id, 'empir3', ''\)/);
  assert.match(cliRun, /cliIsolation = await agyMcpSetup\(id, 'empir3', ''\)/);
  assert.match(cliRun, /runCwd = mode === 'agentic' \? cwd : cliIsolation\.cwd/);
  assert.match(cliRun, /delete env\.OPENAI_API_KEY/);
  assert.match(cliRun, /delete env\.XAI_API_KEY/);
  assert.match(cliRun, /delete env\.GOOGLE_APPLICATION_CREDENTIALS/);
  assert.match(grokVerify, /delete verifyEnv\.XAI_API_KEY/);
  assert.match(grokVerify, /env: verifyEnv/);
});

test('authenticated model-catalog refreshes use isolated homes', () => {
  const catalogs = server.match(/function readCodexModelCatalog[\s\S]*?async function probeCodexCli/)?.[0] || '';
  const codexSetup = server.match(/async function codexCatalogIsolation[\s\S]*?async function populateGeminiTurnHome/)?.[0] || '';

  assert.match(catalogs, /codexCatalogIsolation\(`model-catalog-/);
  assert.match(catalogs, /agyMcpSetup\(`model-catalog-/);
  assert.match(catalogs, /delete env\.XAI_API_KEY/);
  assert.match(catalogs, /delete env\.GOOGLE_APPLICATION_CREDENTIALS/);
  assert.match(codexSetup, /copyTurnAuthFile\(tempHome, \['\.codex', 'auth\.json'\]\)/);
  assert.match(codexSetup, /CODEX_HOME: codexHome/);
});
