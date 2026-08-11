/**
 * Bridge update check — alert-only, never auto-installs.
 *
 * On daemon launch, hits the GitHub releases API for `empir3hq/empir3-bridge`,
 * compares the latest tag to package.json's version, and prints a yellow
 * upgrade banner if a newer version exists.
 *
 * Cached in ~/.empir3-bridge/state.json for 24h so we don't hammer the API.
 * Network failures are silent — never block startup.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const REPO = 'empir3hq/empir3-bridge';
const STATE_DIR = path.join(os.homedir(), '.empir3-bridge');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 3000;

function readPackageVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8')
    );
    return pkg.version;
  } catch {
    return null;
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

function fetchLatestRelease() {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'api.github.com',
      path: `/repos/${REPO}/releases/latest`,
      headers: {
        'User-Agent': 'empir3-bridge-update-check',
        'Accept': 'application/vnd.github+json',
      },
      timeout: FETCH_TIMEOUT_MS,
    };
    const req = https.get(opts, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null);
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.tag_name || null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

// Strip leading "v" and split, return [major, minor, patch] or null on parse failure.
function parseVersion(v) {
  if (!v) return null;
  const clean = String(v).replace(/^v/, '').split('-')[0]; // drop pre-release suffix
  const parts = clean.split('.').map((n) => parseInt(n, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
  return parts;
}

// Returns true if `a` is strictly newer than `b`. Both must be parseable.
function isNewer(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return false;
}

async function checkForUpdate() {
  const current = readPackageVersion();
  if (!current) return; // can't check without a known current version

  const state = readState();
  const cached = state.updateCheck;
  const now = Date.now();

  let latestTag;
  if (cached && cached.checkedAt && now - cached.checkedAt < CACHE_TTL_MS) {
    latestTag = cached.latestTag;
  } else {
    latestTag = await fetchLatestRelease();
    if (latestTag !== null) {
      state.updateCheck = { checkedAt: now, latestTag };
      writeState(state);
    }
  }

  if (latestTag && isNewer(latestTag, current)) {
    const reset = '\x1b[0m';
    const yellow = '\x1b[33m';
    const bold = '\x1b[1m';
    console.log('');
    console.log(`  ${yellow}${bold}⚠ Update available${reset}${yellow}: bridge ${latestTag} (you're on v${current})${reset}`);
    console.log(`  ${yellow}  Upgrade: cd into your bridge repo, then:${reset}`);
    console.log(`  ${yellow}    git pull && npm install${reset}`);
    console.log('');
  }
}

module.exports = { checkForUpdate, isNewer, parseVersion };
