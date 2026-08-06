/**
 * Cross-platform CLI install + terminal-launch policy.
 *
 * Kept as plain CommonJS so the daemon, packaged Electron runtime, and the
 * Node test runner all consume exactly the same decisions. The catalog is
 * deliberately platform-specific: macOS and Linux must never silently share
 * an installer merely because both have a POSIX shell.
 */

'use strict';

const CLI_INSTALL_CATALOG = Object.freeze({
  claude: {
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code/getting-started',
    note: 'Claude Code supports subscription sign-in. Node 18+ is required for the npm installer.',
    windows: { command: 'npm install -g @anthropic-ai/claude-code', shell: 'cmd' },
    macos: { command: 'npm install -g @anthropic-ai/claude-code', shell: 'bash' },
    linux: { command: 'npm install -g @anthropic-ai/claude-code', shell: 'bash' },
  },
  codex: {
    docsUrl: 'https://developers.openai.com/codex/cli',
    note: 'Codex CLI supports ChatGPT subscription sign-in and API-key sign-in; macOS/Linux use the current standalone installer.',
    windows: { command: 'npm install -g @openai/codex', shell: 'cmd' },
    macos: { command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', shell: 'bash' },
    linux: { command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', shell: 'bash' },
  },
  gemini: {
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
    note: 'Google individual subscription users should use Antigravity; Gemini CLI remains available for enterprise and API-key authentication.',
    windows: { command: 'npm install -g @google/gemini-cli', shell: 'cmd' },
    macos: { command: 'npm install -g @google/gemini-cli', shell: 'bash' },
    linux: { command: 'npm install -g @google/gemini-cli', shell: 'bash' },
  },
  grok: {
    docsUrl: 'https://docs.x.ai/docs/cli',
    note: 'The official xAI installer places grok in the user profile.',
    windows: { command: 'irm https://x.ai/cli/install.ps1 | iex', shell: 'pwsh' },
    macos: { command: 'curl -fsSL https://x.ai/cli/install.sh | bash', shell: 'bash' },
    linux: { command: 'curl -fsSL https://x.ai/cli/install.sh | bash', shell: 'bash' },
  },
  higgsfield: {
    docsUrl: 'https://www.npmjs.com/package/@higgsfield/cli',
    note: 'Downloads a native binary during install; requires Node 18+ and network access.',
    windows: { command: 'npm install -g @higgsfield/cli', shell: 'cmd' },
    macos: { command: 'npm install -g @higgsfield/cli', shell: 'bash' },
    linux: { command: 'npm install -g @higgsfield/cli', shell: 'bash' },
  },
  github: {
    docsUrl: 'https://github.com/cli/cli#installation',
    note: 'GitHub publishes different Linux instructions for each distribution, so the Bridge links to the official selector instead of guessing.',
    windows: { command: 'winget install --id GitHub.cli -e --source winget', shell: 'cmd' },
    macos: { command: 'brew install gh', shell: 'bash' },
    linux: {
      command: 'Use the official GitHub CLI instructions for your Linux distribution',
      shell: null,
      blocker: 'Linux installation is distribution-specific. Open the official instructions, install gh, then click Re-scan.',
    },
  },
  agy: {
    docsUrl: 'https://antigravity.google',
    note: 'Antigravity is the supported Google subscription CLI for individual accounts.',
    windows: { command: 'irm https://antigravity.google/cli/install.ps1 | iex', shell: 'pwsh' },
    macos: { command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', shell: 'bash' },
    linux: { command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', shell: 'bash' },
  },
});

const LINUX_TERMINALS = Object.freeze([
  'x-terminal-emulator',
  'gnome-terminal',
  'konsole',
  'xfce4-terminal',
  'tilix',
  'xterm',
]);

function platformKey(platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  return platform || 'unknown';
}

function platformLabel(platform, headless = false) {
  if (platform === 'win32') return headless ? 'Windows headless' : 'Windows desktop';
  if (platform === 'darwin') return headless ? 'macOS headless' : 'macOS desktop';
  if (platform === 'linux') return headless ? 'Linux headless' : 'Linux desktop';
  return platform || 'Unknown platform';
}

function resolveCliInstall(provider, options = {}) {
  const platform = options.platform || process.platform;
  const headless = options.headless === true;
  const spec = CLI_INSTALL_CATALOG[provider];
  if (!spec) return null;
  const key = platformKey(platform);
  const recipe = spec[key];
  if (!recipe) {
    return {
      provider,
      platform: key,
      platformLabel: platformLabel(platform, headless),
      command: '',
      docsUrl: spec.docsUrl,
      note: spec.note,
      launchSupported: false,
      blocker: `No ${platformLabel(platform, headless)} install recipe is available.`,
      run: null,
    };
  }
  const headlessBlocker = headless
    ? `This Bridge is running headless, so it cannot open a desktop terminal. Run the command in your SSH terminal, then click Re-scan.`
    : '';
  return {
    provider,
    platform: key,
    platformLabel: platformLabel(platform, headless),
    command: recipe.command,
    docsUrl: spec.docsUrl,
    note: spec.note,
    launchSupported: Boolean(recipe.shell) && !headlessBlocker,
    blocker: headlessBlocker || recipe.blocker || '',
    run: recipe.shell ? { shell: recipe.shell, line: recipe.command } : null,
  };
}

function shellQuotePosix(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function posixCommandLine(executable, args = []) {
  return [executable, ...args].map(shellQuotePosix).join(' ');
}

function appleScriptString(value) {
  return `"${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}"`;
}

function visibleShellScript(command, cwd, keepOpen = true) {
  const prefix = `cd ${shellQuotePosix(cwd)} && `;
  if (!keepOpen) return `${prefix}exec ${command}`;
  return `${prefix}${command}; empir3_status=$?; printf '\\nEmpir3 Bridge command finished (exit %s). Press Enter to close.\\n' "$empir3_status"; read -r _; exit "$empir3_status"`;
}

/**
 * Produce a spawn contract for a real, visible terminal.
 * `terminal` is required on Linux and ignored on macOS.
 */
function visibleTerminalPlan(options) {
  const { platform, terminal, command, cwd, keepOpen = true } = options;
  const script = visibleShellScript(command, cwd, keepOpen);
  if (platform === 'darwin') {
    return {
      executable: 'osascript',
      args: [
        '-e', `tell application "Terminal" to do script ${appleScriptString(script)}`,
        '-e', 'tell application "Terminal" to activate',
      ],
    };
  }
  if (platform !== 'linux') return null;
  const name = String(terminal || '').split(/[\\/]/).pop();
  if (!name) return null;
  if (name === 'gnome-terminal' || name === 'tilix') {
    return { executable: terminal, args: ['--', 'bash', '-lc', script] };
  }
  if (name === 'xfce4-terminal') {
    return {
      executable: terminal,
      args: ['--disable-server', '--command', `bash -lc ${shellQuotePosix(script)}`],
    };
  }
  return { executable: terminal, args: ['-e', 'bash', '-lc', script] };
}

function cliPlatformSummary(provider, options = {}) {
  const platform = options.platform || process.platform;
  const headless = options.headless === true;
  const install = resolveCliInstall(provider, { platform, headless });
  return {
    label: platformLabel(platform, headless),
    executionSupported: Boolean(install),
    authLaunchSupported: !headless && ['win32', 'darwin', 'linux'].includes(platform),
    installLaunchSupported: Boolean(install && install.launchSupported),
    blocker: install?.blocker || '',
  };
}

module.exports = {
  CLI_INSTALL_CATALOG,
  LINUX_TERMINALS,
  platformKey,
  platformLabel,
  resolveCliInstall,
  shellQuotePosix,
  posixCommandLine,
  visibleShellScript,
  visibleTerminalPlan,
  cliPlatformSummary,
};
