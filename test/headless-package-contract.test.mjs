import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const installer = readFileSync(new URL('../headless-package/assets/install.sh', import.meta.url), 'utf8');

test('headless systemd host executes immutable code from a writable service-home working directory', () => {
  assert.match(installer, /^WorkingDirectory=\$SERVICE_HOME$/m);
  assert.match(installer, /^ExecStart=\$\(command -v node\) \$PREFIX\/current\/src\/headless-entry\.js$/m);
  assert.match(installer, /^User=\$SERVICE_USER$/m);
  assert.match(installer, /^StartLimitIntervalSec=60$/m);
  assert.match(installer, /^StartLimitBurst=5$/m);
  assert.match(installer, /^ProtectSystem=full$/m);
  assert.match(installer, /^ReadWritePaths=\$SERVICE_HOME$/m);
});

test('headless install has bounded health, restart detection, and signed update timer contracts', () => {
  assert.match(installer, /for _ in \$\(seq 1 60\)/);
  assert.match(installer, /systemctl show -p NRestarts/);
  assert.match(installer, /new release failed its health gate; restoring the previous release/);
  assert.match(installer, /^ExecStart=\$\(command -v node\) \$PREFIX\/current\/src\/headless-update\.cjs run$/m);
  assert.match(installer, /^OnUnitActiveSec=30min$/m);
});

test('same-version repair replaces runtime bytes and restores the prior copy on failure', () => {
  assert.doesNotMatch(installer, /already installed; refreshing its service contract/);
  assert.match(installer, /if \[ -e "\$RELEASE" \]; then mv -- "\$RELEASE" "\$BACKUP"; fi\s+mv -- "\$STAGING" "\$RELEASE"/);
  assert.match(installer, /systemctl stop "\$UNIT"[\s\S]*if \[ -e "\$BACKUP" \]; then\s+rm -rf -- "\$RELEASE"\s+mv -- "\$BACKUP" "\$RELEASE"/);
  assert.match(installer, /mv -Tf "\$PREFIX\/current\.next" "\$PREFIX\/current"\s+systemctl reset-failed "\$UNIT"[\s\S]*systemctl restart "\$UNIT"/);
});
