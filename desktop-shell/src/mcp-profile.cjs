'use strict';

const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');

function isolateMcpProfile(app) {
  const directory = mkdtempSync(join(app.getPath('temp'), 'empir3-bridge-mcp-'));
  const cleanup = () => {
    // Only the freshly created profile belongs to this process. Chromium may
    // briefly retain a file on Windows during shutdown; never touch any other
    // profile, installed Bridge state or credentials to force cleanup.
    try { rmSync(directory, { recursive: true, force: true }); } catch {}
  };
  try {
    app.setPath('userData', directory);
    app.setPath('sessionData', directory);
  } catch (error) {
    cleanup();
    throw error;
  }
  return cleanup;
}

module.exports = { isolateMcpProfile };
