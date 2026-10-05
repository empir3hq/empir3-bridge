import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import test from 'node:test';

const main = readFileSync(new URL('../desktop-shell/src/main.cjs', import.meta.url), 'utf8');
const forge = readFileSync(new URL('../desktop-shell/forge.config.cjs', import.meta.url), 'utf8');
const stager = readFileSync(new URL('../scripts/stage-bridge-runtime.cjs', import.meta.url), 'utf8');
const legacyTray = readFileSync(new URL('../tray/tray.py', import.meta.url), 'utf8');
const legacyTrayBuild = readFileSync(new URL('../tray/build.py', import.meta.url), 'utf8');

test('the complete Bridge icon matrix is generated and non-empty', () => {
  for (const filename of [
    'bridge.png',
    'bridge.ico',
    'bridge.icns',
    'bridge-tray-connected.png',
    'bridge-tray-disconnected.png',
  ]) {
    const url = new URL(`../assets/icons/${filename}`, import.meta.url);
    assert.equal(existsSync(url), true, `${filename} is missing`);
    assert.ok(statSync(url).size > 500, `${filename} is unexpectedly small`);
  }
});

test('window, taskbar, tray, installers, and staged runtime use Bridge branding', () => {
  assert.match(main, /icon: loadBridgeIcon/);
  assert.match(main, /app\.setAppUserModelId\('com\.empir3\.bridge'\)/);
  assert.match(main, /bridge-tray-connected\.png/);
  assert.match(main, /bridge-tray-disconnected\.png/);
  assert.doesNotMatch(main, /zara-accent\.png/);
  assert.match(forge, /icon: packageIcon/);
  assert.match(forge, /setupIcon: join\(iconRoot, 'bridge\.ico'\)/);
  assert.match(stager, /cpSync\(iconSource, join\(output, 'assets', 'icons'\), \{ recursive: true \}\)/);
  assert.match(legacyTray, /bridge-tray-connected\.png/);
  assert.match(legacyTray, /bridge-tray-disconnected\.png/);
  assert.doesNotMatch(legacyTray, /text = 'E'/);
  assert.match(legacyTrayBuild, /'--icon', str\(ICONS_DIR \/ 'bridge\.ico'\)/);
  assert.match(legacyTrayBuild, /'--add-data'/);
});

test('the Windows bootstrap icon and resource were regenerated', () => {
  const sourceIco = readFileSync(new URL('../assets/icons/bridge.ico', import.meta.url));
  const bootstrapIco = readFileSync(new URL('../build/bootstrap-go/empir3.ico', import.meta.url));
  assert.deepEqual(bootstrapIco, sourceIco);
  assert.ok(statSync(new URL('../build/bootstrap-go/resource_windows_amd64.syso', import.meta.url)).size > 1000);
});
