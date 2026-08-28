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
    windows: {
      command: 'Windows automatic install paused — use the official Higgsfield page for updates',
      shell: null,
      note: 'Windows automatic install is paused while the official v1.1.23 hf.exe is classified by Microsoft Defender as Trojan:Win32/Bearfoos.A!ml.',
      blocker: 'Do not bypass Windows Security or add a Defender exclusion. Wait for Higgsfield or Microsoft to clear the official Windows binary, then install from the official page and click Re-scan.',
    },
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

/**
 * Fixed, vendor-owned lifecycle actions. Nothing in this catalog accepts
 * user-supplied shell text. The console can therefore expose update and
 * sign-out controls without turning localhost into an arbitrary command
 * launcher.
 *
 * `latest` describes a read-only source. Antigravity deliberately has no
 * latest source: its public CLI only exposes the mutating `agy update`
 * command, so the UI reports that limitation instead of inventing a version.
 */
const CLI_LIFECYCLE_CATALOG = Object.freeze({
  claude: {
    latest: { kind: 'npm', packageName: '@anthropic-ai/claude-code', source: 'npm registry' },
    update: { bin: 'claude', args: ['update'], label: 'Update Claude Code' },
    deauthorize: { bin: 'claude', args: ['auth', 'logout'], label: 'Sign out of Claude Code', mode: 'command' },
  },
  codex: {
    latest: { kind: 'npm', packageName: '@openai/codex', source: 'npm registry' },
    update: { bin: 'codex', args: ['update'], label: 'Update Codex' },
    deauthorize: { bin: 'codex', args: ['logout'], label: 'Sign out of Codex', mode: 'command' },
  },
  gemini: {
    latest: { kind: 'npm', packageName: '@google/gemini-cli', source: 'npm registry' },
    update: { bin: 'npm', args: ['install', '-g', '@google/gemini-cli@latest'], label: 'Update Gemini CLI' },
    deauthorize: {
      bin: 'gemini', args: [], label: 'Manage Gemini sign-in', mode: 'interactive',
      instruction: 'Use /auth in the Gemini window to change the saved account or authentication method.',
    },
  },
  grok: {
    latest: { kind: 'grok-self-update', source: 'xAI stable updater' },
    update: { bin: 'grok', args: ['update'], label: 'Update Grok' },
    deauthorize: { bin: 'grok', args: ['logout'], label: 'Sign out of Grok', mode: 'command' },
  },
  agy: {
    latest: null,
    update: { bin: 'agy', args: ['update'], label: 'Run Antigravity updater' },
    deauthorize: {
      bin: 'agy', args: [], label: 'Open Antigravity sign-out', mode: 'interactive',
      instruction: 'Type /logout in the Antigravity window. Google requires sign-out from the interactive prompt.',
    },
  },
  higgsfield: {
    latest: { kind: 'npm', packageName: '@higgsfield/cli', source: 'npm registry' },
    update: {
      windows: null,
      macos: { bin: 'npm', args: ['install', '-g', '@higgsfield/cli@latest'], label: 'Update Higgsfield CLI' },
      linux: { bin: 'npm', args: ['install', '-g', '@higgsfield/cli@latest'], label: 'Update Higgsfield CLI' },
    },
    deauthorize: { bin: 'higgsfield', args: ['auth', 'logout'], label: 'Sign out of Higgsfield', mode: 'command' },
  },
  github: {
    latest: { kind: 'github-release', repo: 'cli/cli', source: 'GitHub Releases' },
    update: {
      windows: { bin: 'winget', args: ['upgrade', '--id', 'GitHub.cli', '-e', '--source', 'winget', '--accept-source-agreements'], label: 'Update GitHub CLI' },
      macos: { bin: 'brew', args: ['upgrade', 'gh'], label: 'Update GitHub CLI' },
      linux: null,
    },
    deauthorize: { bin: 'gh', args: ['auth', 'logout'], label: 'Sign out of GitHub CLI', mode: 'command' },
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
    note: recipe.note || spec.note,
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

function actionForPlatform(action, platform) {
  if (!action) return null;
  if (action.bin) return action;
  return action[platformKey(platform)] || null;
}

function commandText(action) {
  if (!action) return '';
  return [action.bin, ...(action.args || [])].join(' ');
}

function resolveCliLifecycle(provider, options = {}) {
  const platform = options.platform || process.platform;
  const headless = options.headless === true;
  const spec = CLI_LIFECYCLE_CATALOG[provider];
  if (!spec) return null;
  const update = actionForPlatform(spec.update, platform);
  const deauthorize = actionForPlatform(spec.deauthorize, platform);
  return {
    provider,
    checkSupported: Boolean(spec.latest),
    latestSource: spec.latest?.source || 'vendor-managed updater',
    update: update ? {
      command: commandText(update),
      label: update.label || 'Update',
      launchSupported: !headless,
      blocker: headless ? 'Run this update command in your SSH terminal.' : '',
    } : {
      command: '',
      label: 'Update instructions',
      launchSupported: false,
      blocker: provider === 'github' && platform === 'linux'
        ? 'Use the official GitHub CLI update instructions for your Linux distribution.'
        : `No automatic update action is available on ${platformLabel(platform, headless)}.`,
    },
    deauthorize: deauthorize ? {
      command: commandText(deauthorize),
      label: deauthorize.label || 'Sign out',
      mode: deauthorize.mode || 'command',
      instruction: deauthorize.instruction || '',
      launchSupported: !headless,
      blocker: headless ? 'Run this sign-out command in your SSH terminal.' : '',
    } : null,
  };
}

function extractSemanticVersion(value) {
  const match = String(value || '').match(/(?:^|\s|v)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return match ? match[1] : null;
}

function compareSemanticVersions(left, right) {
  const a = extractSemanticVersion(left);
  const b = extractSemanticVersion(right);
  if (!a || !b) return null;
  const parse = (value) => {
    const [core, prerelease = ''] = value.split('-', 2);
    return { nums: core.split('.').map(Number), prerelease };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  if (pa.prerelease === pb.prerelease) return 0;
  if (!pa.prerelease) return 1;
  if (!pb.prerelease) return -1;
  return pa.prerelease.localeCompare(pb.prerelease);
}

module.exports = {
  CLI_INSTALL_CATALOG,
  CLI_LIFECYCLE_CATALOG,
  LINUX_TERMINALS,
  platformKey,
  platformLabel,
  resolveCliInstall,
  shellQuotePosix,
  posixCommandLine,
  visibleShellScript,
  visibleTerminalPlan,
  cliPlatformSummary,
  actionForPlatform,
  commandText,
  resolveCliLifecycle,
  extractSemanticVersion,
  compareSemanticVersions,
};
