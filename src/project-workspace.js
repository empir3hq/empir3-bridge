'use strict';

const { mkdirSync, realpathSync } = require('node:fs');
const { isAbsolute, relative, resolve, sep } = require('node:path');
const { spawn } = require('node:child_process');

function isWithinRoot(targetPath, rootPath) {
  const rel = relative(resolve(rootPath), resolve(targetPath));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Create a project directory and prove that its real path remains beneath the
 * configured Projects root. The realpath check also rejects junction/symlink
 * escapes that a textual `startsWith(root)` check would miss.
 */
function prepareProjectDirectory(rootPath, projectPath) {
  if (!rootPath || !projectPath || !isWithinRoot(projectPath, rootPath) || resolve(projectPath) === resolve(rootPath)) {
    throw new Error('Project directory is outside the configured Projects folder');
  }
  mkdirSync(rootPath, { recursive: true });
  mkdirSync(projectPath, { recursive: true });
  const realRoot = realpathSync(rootPath);
  const realProject = realpathSync(projectPath);
  if (!isWithinRoot(realProject, realRoot) || realProject === realRoot) {
    throw new Error('Project directory resolves outside the configured Projects folder');
  }
  return realProject;
}

function directoryOpenPlan(platform, targetPath) {
  if (platform === 'win32') return { command: 'explorer.exe', args: [targetPath] };
  if (platform === 'darwin') return { command: 'open', args: [targetPath] };
  if (platform === 'linux') return { command: 'xdg-open', args: [targetPath] };
  return null;
}

/** Launch the platform file manager without a shell or interpolated command. */
function openProjectDirectory(targetPath, options = {}) {
  const profile = options.profile || {};
  if (profile.headless || profile.hasDisplay === false) {
    return Promise.resolve({
      success: false,
      code: 'capability_unsupported',
      error: 'Local project folders can only be opened on a Bridge computer with a desktop session.',
    });
  }
  const plan = directoryOpenPlan(options.platform || process.platform, targetPath);
  if (!plan) {
    return Promise.resolve({ success: false, code: 'capability_unsupported', error: 'This operating system cannot open a local project folder.' });
  }

  const spawnFn = options.spawnFn || spawn;
  return new Promise((resolveResult) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };
    let child;
    try {
      child = spawnFn(plan.command, plan.args, {
        detached: true,
        stdio: 'ignore',
        // `windowsHide:true` is appropriate for console helpers, but Explorer
        // honors it for the folder window itself. The process successfully
        // spawned while every requested folder remained invisible.
        windowsHide: false,
      });
    } catch (error) {
      finish({ success: false, error: error?.message || String(error) });
      return;
    }
    child.once?.('error', (error) => finish({ success: false, error: error?.message || String(error) }));
    child.once?.('spawn', () => {
      child.unref?.();
      finish({ success: true });
    });
  });
}

module.exports = {
  directoryOpenPlan,
  isWithinRoot,
  openProjectDirectory,
  prepareProjectDirectory,
};
