'use strict';

const { existsSync, mkdirSync, readFileSync, rmSync } = require('node:fs');
const { basename, join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  checkForReleaseUpdate,
  downloadVerifiedArtifact,
  loadOrCreateUpdateState,
  saveUpdateState,
} = require('./updater.cjs');
const { extractTarGz } = require('./tar-util.cjs');
const { validateInstallConfig } = require('./install-config.cjs');

const runtimeRoot = resolve(__dirname, '..');
const configPath = process.env.EMPIR3_HEADLESS_INSTALL_CONFIG || '/etc/empir3-bridge-install.json';
const stateRoot = process.env.EMPIR3_HEADLESS_UPDATE_STATE || '/var/lib/empir3-bridge';
const cacheRoot = process.env.EMPIR3_HEADLESS_UPDATE_CACHE || '/var/cache/empir3-bridge';
const statePath = join(stateRoot, 'update-state.json');
const manifestUrl = process.env.EMPIR3_DESKTOP_MANIFEST_URL;

function readPublicKey() {
  const trust = JSON.parse(readFileSync(join(runtimeRoot, 'trust', 'update-public-key.json'), 'utf8'));
  return String(trust.publicKeyHex || '');
}

async function run(mode = 'check') {
  const currentVersion = readFileSync(join(runtimeRoot, '.payload-version'), 'utf8').trim();
  const state = loadOrCreateUpdateState(statePath);
  const result = await checkForReleaseUpdate({
    ...(manifestUrl ? { manifestUrl } : {}),
    currentVersion,
    platform: 'linux',
    arch: process.arch,
    hostType: 'headless',
    artifactKind: 'archive',
    deviceId: state.deviceId,
    publicKeyHex: readPublicKey(),
  });
  console.log(`[empir3-bridge-update] ${result.status}${result.manifest?.version ? ` (${currentVersion} -> ${result.manifest.version})` : ''}`);
  if (mode !== 'run' || !['available', 'rollback-available'].includes(result.status)) return result;
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    throw new Error('Installing a headless update requires root/systemd');
  }
  if (!result.artifact || result.artifact.format !== 'tar.gz') throw new Error('Headless release did not select a tar.gz package');
  const config = validateInstallConfig(JSON.parse(readFileSync(configPath, 'utf8')));
  const name = basename(String(result.artifact.publicName || ''));
  if (!/^empir3-bridge-linux-headless-(?:x64|arm64)-[0-9A-Za-z.+_-]+\.tar\.gz$/.test(name)) {
    throw new Error('Headless artifact name is unsafe');
  }
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const archive = join(cacheRoot, name);
  const staging = join(stateRoot, `staging-${process.pid}-${Date.now()}`);
  state.lastAttemptAt = new Date().toISOString();
  state.lastAttemptVersion = String(result.manifest.version);
  saveUpdateState(statePath, state);
  try {
    await downloadVerifiedArtifact(result.artifact, archive);
    extractTarGz(archive, staging);
    const installer = join(staging, 'install.sh');
    if (!existsSync(installer) || !existsSync(join(staging, 'runtime', '.payload-version'))) {
      throw new Error('Downloaded headless package is incomplete');
    }
    const install = spawnSync('bash', [
      installer,
      '--prefix', config.prefix,
      '--user', config.serviceUser,
      '--server', config.server,
    ], { cwd: staging, stdio: 'inherit', shell: false });
    if (install.status !== 0) throw new Error(`Headless installer failed with exit ${install.status}`);
    state.lastSuccessAt = new Date().toISOString();
    state.lastSuccessVersion = String(result.manifest.version);
    state.lastStatus = result.status;
    delete state.lastError;
    saveUpdateState(statePath, state);
    return result;
  } catch (error) {
    state.lastError = String(error?.message || error).slice(0, 1000);
    state.lastStatus = 'failed';
    saveUpdateState(statePath, state);
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const mode = process.argv[2] || 'check';
  if (!['check', 'run'].includes(mode)) {
    console.error('usage: node headless-update.cjs [check|run]');
    process.exit(2);
  }
  run(mode).catch((error) => {
    console.error(`[empir3-bridge-update] ${error?.stack || error}`);
    process.exit(1);
  });
}

module.exports = { run };
