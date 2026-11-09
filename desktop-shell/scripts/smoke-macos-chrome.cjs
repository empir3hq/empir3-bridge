'use strict';

const { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { isAbsolute, join } = require('node:path');

const quote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;

// Chrome's macOS renderer stalls when HOME disagrees with the OS account home.
// Restore it only in this browser launcher, never in the Bridge/CLI processes.
// An explicit disposable profile is mandatory before the browser can start.
function prepareMacSmokeChrome(scratch, { platform = process.platform, home = homedir(), chromePath = process.env.CHROME_PATH } = {}) {
  if (platform !== 'darwin') return null;
  const chrome = chromePath || [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  ].find(existsSync);
  if (!chrome || !isAbsolute(chrome) || !existsSync(chrome)) throw new Error('Native Mac smoke Chrome was not found');
  const root = realpathSync(scratch);
  const launcher = join(root, 'smoke-chrome.sh');
  const script = `#!/bin/sh
set -eu
profile=''
for arg in "$@"; do
  case "$arg" in
    --user-data-dir=*)
      [ -z "$profile" ] || exit 64
      profile="\${arg#--user-data-dir=}"
      ;;
    --user-data-dir) exit 64 ;;
  esac
done
[ -n "$profile" ] && [ -d "$profile" ] || exit 64
profile="$(cd "$profile" && pwd -P)"
case "$profile" in ${quote(root)}/*) ;; *) exit 64 ;; esac
export HOME=${quote(home)}
exec ${quote(chrome)} "$@"
`;
  // Update/rollback acceptance intentionally reuses the same retained state.
  // Reuse only this exact launcher; never overwrite an unrelated file/link.
  if (existsSync(launcher)) {
    const entry = lstatSync(launcher);
    if (!entry.isFile() || entry.isSymbolicLink() || readFileSync(launcher, 'utf8') !== script) {
      throw new Error('Existing Mac smoke launcher does not match this fixture');
    }
  } else writeFileSync(launcher, script, { mode: 0o700, flag: 'wx' });
  return launcher;
}

module.exports = { prepareMacSmokeChrome };
