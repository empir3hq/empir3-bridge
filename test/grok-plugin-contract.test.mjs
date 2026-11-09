import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

// The Grok Build plugin lives in grok-plugin/ and is listed in the public
// marketplace by a pinned commit. These checks keep its JSON parseable, its
// tool names real, its version honest and its copy within the listing rules.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const pluginRoot = join(repoRoot, 'grok-plugin');
const read = (...parts) => readFileSync(join(repoRoot, ...parts), 'utf8');

const mcpServerSource = read('src', 'mcp-server.ts');
const registeredTools = new Set(
  [...mcpServerSource.matchAll(/server\.tool\(\s*'([a-z0-9_]+)'/g)].map((m) => m[1]),
);

// Backticked identifiers in the plugin copy that look like tool names but are
// result codes, parameter values or model ids. Everything else with one of the
// tool prefixes must be a registered tool.
const NON_TOOL_TOKENS = new Set([
  'cli_not_installed',
  'desktop_locked',
]);
const TOOL_PREFIX = /^(browser|desktop|bridge|cli|higgsfield|page_to_screen|custom_llm)(_[a-z0-9]+)*$/;

const SKILLS = [
  'control-my-browser',
  'use-my-desktop',
  'delegate-to-my-ai-clis',
  'record-and-replay-a-routine',
];

function frontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(match, 'SKILL.md must start with a frontmatter block');
  const block = match[1];
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const descriptionStart = block.search(/^description:/m);
  assert.ok(descriptionStart >= 0, 'frontmatter needs a description');
  const description = block.slice(descriptionStart).replace(/^description:\s*(>-?)?/, '').trim();
  return { name, description };
}

function backtickedToolNames(markdown) {
  return [...markdown.matchAll(/`([a-z0-9_]+)`/g)]
    .map((m) => m[1])
    .filter((token) => TOOL_PREFIX.test(token) && !NON_TOOL_TOKENS.has(token));
}

test('the MCP server registers the tool inventory the plugin is built on', () => {
  assert.ok(registeredTools.size >= 90, `expected the full inventory, found ${registeredTools.size}`);
  for (const name of ['browser_status', 'browser_snapshot', 'browser_click_ref', 'cli_status', 'cli_run', 'browser_record_start', 'browser_play', 'bridge_safety_status', 'bridge_revoke_control']) {
    assert.ok(registeredTools.has(name), `${name} is missing from src/mcp-server.ts`);
  }
});

test('the plugin .mcp.json parses and starts the cross-platform npm MCP entry', () => {
  const config = JSON.parse(read('grok-plugin', '.mcp.json'));
  const server = config.mcpServers?.['empir3-bridge'];
  assert.ok(server, 'mcpServers.empir3-bridge must exist');
  assert.equal(server.type, 'stdio');
  assert.equal(server.command, 'npx');
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(server.args, ['-y', '-p', `@empir3hq/empir3-bridge@${pkg.version}`, 'empir3-bridge-mcp'], 'the catalog must run the reviewed release, never whatever npm latest resolves to');
  assert.equal(pkg.bin['empir3-bridge-mcp'], 'src/mcp-entry.js', 'the npm bin the plugin starts must stay published');
  assert.ok(existsSync(join(repoRoot, 'src', 'mcp-entry.js')));
  // The README's published-package snippet and the plugin must start the same thing.
  assert.match(read('README.md'), /"args": \["-y", "-p", "@empir3hq\/empir3-bridge", "empir3-bridge-mcp"\]/);
});

test('plugin.json carries the Empir3 HQ identity and the package version', () => {
  const manifest = JSON.parse(read('grok-plugin', '.grok-plugin', 'plugin.json'));
  const pkg = JSON.parse(read('package.json'));
  assert.equal(manifest.name, 'empir3');
  assert.equal(manifest.version, pkg.version, 'bump grok-plugin/.grok-plugin/plugin.json with package.json');
  assert.equal(manifest.author?.name, 'Empir3 HQ');
  assert.equal(manifest.homepage, 'https://empir3.com');
  assert.equal(manifest.repository, 'https://github.com/empir3hq/empir3-bridge');
  assert.equal(manifest.license, pkg.license);
  assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.includes('empir3'));
  const logo = join(pluginRoot, manifest.logo);
  assert.ok(existsSync(logo) && statSync(logo).size > 200, 'logo must exist in the plugin folder');
});

test('each skill has frontmatter that matches its folder and names only real tools', () => {
  const folders = readdirSync(join(pluginRoot, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(folders, [...SKILLS].sort());
  for (const skill of SKILLS) {
    const markdown = read('grok-plugin', 'skills', skill, 'SKILL.md');
    const { name, description } = frontmatter(markdown);
    assert.equal(name, skill, `${skill}/SKILL.md frontmatter name must equal the folder`);
    assert.ok(description.length > 40, `${skill} description is too short to trigger`);
    const tools = backtickedToolNames(markdown);
    assert.ok(tools.length >= 5, `${skill} should teach concrete tools`);
    for (const tool of tools) {
      assert.ok(registeredTools.has(tool), `${skill} names ${tool}, which src/mcp-server.ts does not register`);
    }
  }
});

test('the plugin README and the maintainer guide name only real tools', () => {
  for (const file of [['grok-plugin', 'README.md'], ['docs', 'GROK_BUILD_PLUGIN.md']]) {
    for (const tool of backtickedToolNames(read(...file))) {
      assert.ok(registeredTools.has(tool), `${file.join('/')} names ${tool}, which src/mcp-server.ts does not register`);
    }
  }
});

test('plugin copy keeps the listing rules: Empir3 by name, no comparative or control claims', () => {
  const files = [
    ['grok-plugin', 'README.md'],
    ['grok-plugin', '.grok-plugin', 'plugin.json'],
    ['docs', 'GROK_BUILD_PLUGIN.md'],
    ...SKILLS.map((skill) => ['grok-plugin', 'skills', skill, 'SKILL.md']),
  ];
  const internal = join(repoRoot, 'docs', 'internal', 'GROK_BUILD_MARKETPLACE_PR.md');
  if (existsSync(internal)) files.push(['docs', 'internal', 'GROK_BUILD_MARKETPLACE_PR.md']);
  for (const file of files) {
    const text = read(...file);
    assert.doesNotMatch(text, /Empire Bot|Empir3 Bot/i, `${file.join('/')} must call the connector Empir3`);
    assert.doesNotMatch(text, /better than/i, `${file.join('/')} must not make comparative claims`);
    assert.doesNotMatch(text, /orchestrat\w+ (Grok Bot|Muse|dots)/i, `${file.join('/')} must not claim to drive other products`);
  }
});

test('the private PR note holds a valid catalog entry for the public repository', (t) => {
  const path = join(repoRoot, 'docs', 'internal', 'GROK_BUILD_MARKETPLACE_PR.md');
  if (!existsSync(path)) {
    t.skip('docs/internal is dropped from the public export');
    return;
  }
  const markdown = readFileSync(path, 'utf8');
  const block = markdown.match(/```json\r?\n([\s\S]*?)\r?\n```/);
  assert.ok(block, 'the PR note must contain the marketplace entry as a JSON block');
  const entry = JSON.parse(block[1]);
  assert.equal(entry.name, 'empir3');
  assert.equal(entry.category, 'productivity');
  assert.equal(entry.source.source, 'url');
  assert.equal(entry.source.url, 'https://github.com/empir3hq/empir3-bridge.git');
  assert.equal(entry.source.path, 'grok-plugin');
  assert.ok(
    entry.source.sha === '<HQ_RELEASE_SHA>' || /^[0-9a-f]{40}$/.test(entry.source.sha),
    'sha must be the placeholder or a full lowercase commit SHA',
  );
  assert.equal(entry.homepage, 'https://github.com/empir3hq/empir3-bridge');
  assert.deepEqual(entry.domains, ['empir3.com', 'app.empir3.com']);
  for (const keyword of ['empir3', 'browser control', 'desktop control', 'ai team', 'bridge', 'cli delegation']) {
    assert.ok(entry.keywords.includes(keyword), `keyword ${keyword} missing`);
  }
});

test('the public exporter ships the plugin and its guide', (t) => {
  // The exporter drops itself from the public repository; there this test has nothing to check.
  if (!existsSync(join(repoRoot, 'scripts', 'export-public.mjs'))) {
    t.skip('scripts/export-public.mjs is dropped from the public export');
    return;
  }
  const exporter = read('scripts', 'export-public.mjs');
  const dropBlock = exporter.match(/const DROP = \[([\s\S]*?)\];/)?.[1] ?? '';
  assert.doesNotMatch(dropBlock, /grok-plugin/, 'grok-plugin/ must reach the public repository');
  assert.doesNotMatch(dropBlock, /GROK_BUILD_PLUGIN/, 'docs/GROK_BUILD_PLUGIN.md must reach the public repository');
  assert.match(dropBlock, /'docs\/internal'/, 'docs/internal stays private');
});
