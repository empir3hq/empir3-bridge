"""Systemd acceptance inside an explicitly marked disposable QEMU guest only."""
import hashlib
import http.server
import json
import os
import platform
from pathlib import Path
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request

if not __debug__:
    raise RuntimeError('Optimized Python would disable acceptance guards')

def run(*args, check=True):
    result = subprocess.run(args, text=True, capture_output=True, timeout=150)
    if check and result.returncode:
        print(result.stdout + result.stderr, file=sys.stderr)
        result.check_returncode()
    return result


phase, nonce = sys.argv[1:]
assert sys.platform == 'linux'
import pwd
assert os.geteuid() == 0
assert Path('/etc/empir3-acceptance-only').read_text().strip() == nonce
assert run('systemd-detect-virt').stdout.strip() in ('kvm', 'qemu')
assert Path('/etc/hostname').read_text().strip() == 'empir3-security-ci'
root = Path('/home/acceptance/input')
receipts = root / 'receipts'
receipts.mkdir(exist_ok=True)
current = Path('/opt/empir3-bridge/current')
marker = Path('/home/empir3/.empir3-bridge/security-acceptance-provider.json')
unit = 'empir3-bridge.service'


def unpack(archive, destination):
    destination.mkdir()
    with tarfile.open(archive) as source:
        source.extractall(destination, filter='data')


def status(expected):
    assert run('systemctl', 'is-active', unit).stdout.strip() == 'active'
    assert (current / '.payload-version').read_text().strip() == expected
    with urllib.request.urlopen('http://127.0.0.1:3006/api/status', timeout=5) as response:
        result = json.load(response)
    assert isinstance(result, dict)
    assert result.get('engine') == 'empir3-bridge' and result.get('version') == expected
    assert Path(f'/proc/{int(result["pid"])}').stat().st_uid == pwd.getpwnam('empir3').pw_uid
    assert run('systemctl', 'show', '-p', 'User', '--value', unit).stdout.strip() == 'empir3'
    pid = int(run('systemctl', 'show', '-p', 'MainPID', '--value', unit).stdout)
    assert Path(f'/proc/{pid}').stat().st_uid == pwd.getpwnam('empir3').pw_uid
    assert current.resolve().stat().st_uid == 0
    assert run('runuser', '-u', 'empir3', '--', 'test', '-w', str(current), check=False).returncode != 0
    # No pairing code or real provider credential enters this VM.
    return {'version': expected, 'pid': pid, 'serviceUser': 'empir3', 'runtimeWritableByService': False}


def install(directory):
    result = run('bash', str(directory / 'install.sh'), '--server', 'http://127.0.0.1:18080')
    (receipts / f'install-{directory.name}.log').write_text(result.stdout + result.stderr)
    run('systemctl', 'disable', '--now', 'empir3-bridge-update.timer', 'empir3-bridge-update.path')


def retain_check():
    assert marker.read_text() == '{"syntheticProvider":"retention-fixture","credential":"not-a-real-key"}\n'


def uninstall(purge=False):
    result = run('/usr/local/sbin/empir3-bridge-uninstall', *(['--purge-data'] if purge else []))
    (receipts / ('purge.log' if purge else 'uninstall.log')).write_text(result.stdout + result.stderr)
    assert not Path('/opt/empir3-bridge').exists()
    assert run('systemctl', 'is-active', unit, check=False).returncode != 0


archive = root / 'candidate.tar.gz'
identity = json.loads((root / 'candidate-identity.json').read_text())
assert hashlib.sha256(archive.read_bytes()).hexdigest() == identity['archiveSha256']
candidate_version = identity['version']
candidate_arch = identity.get('arch', 'x64')
assert candidate_arch in ('x64', 'arm64')
assert platform.machine() in {'x64': ('x86_64', 'amd64'), 'arm64': ('aarch64', 'arm64')}[candidate_arch]
assert run('node', '-p', 'process.arch').stdout.strip() == candidate_arch
exact = root / 'exact'
if phase == 'install':
    assert not Path('/opt/empir3-bridge').exists(), 'Refuse an existing installation'
    assert run('getent', 'passwd', 'empir3', check=False).returncode != 0, 'Refuse an existing service account'
    unpack(archive, exact)
    install(exact)
    result = status(candidate_version)
    marker.write_text('{"syntheticProvider":"retention-fixture","credential":"not-a-real-key"}\n')
    account = pwd.getpwnam('empir3')
    os.chown(marker, account.pw_uid, account.pw_gid)
    marker.chmod(0o600)
    result['bootId'] = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    result['trustSha256'] = hashlib.sha256((current / 'trust/update-public-key.json').read_bytes()).hexdigest()
    (receipts / 'installed.json').write_text(json.dumps(result, indent=2))
elif phase == 'after-reboot':
    before = json.loads((receipts / 'installed.json').read_text())
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    assert boot != before['bootId'], 'A real VM reboot is required'
    for attempt in range(60):
        try:
            result = status(candidate_version)
            break
        except (AssertionError, OSError):
            if attempt == 59:
                raise
            time.sleep(1)
    retain_check()
    result.update(bootId=boot, previousBootId=before['bootId'], realReboot=True)
    (receipts / 'reboot.json').write_text(json.dumps(result, indent=2))
elif phase == 'lifecycle':
    before = json.loads((receipts / 'installed.json').read_text())
    status(candidate_version)
    uninstall()
    retain_check()
    install(exact)
    status(candidate_version)
    retain_check()
    uninstall()
    fixture = root / 'fixture'
    summary = json.loads((fixture / 'fixture.json').read_text())
    assert summary['acceptanceOnly'] and summary['arch'] == candidate_arch
    base = root / 'fixture-base'
    unpack(fixture / summary['packages']['base']['name'], base)
    install(base)
    status('0.3.55')
    retain_check()
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(fixture), **kwargs)
        def log_message(self, *_args):
            pass
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 18080), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    results = []
    try:
        for name, expected in [('update', '0.3.56'), ('rollback', '0.3.55'), ('bad', '0.3.55')]:
            env = dict(os.environ, EMPIR3_DESKTOP_MANIFEST_URL='http://127.0.0.1:18080/' + summary['releases'][name]['manifestName'])
            started = str(int(time.time()))
            result = subprocess.run(['node', str(current / 'src/headless-update.cjs'), 'run'], env=env, text=True, capture_output=True, timeout=180)
            (receipts / f'{name}.log').write_text(result.stdout + result.stderr)
            assert (result.returncode != 0) == (name == 'bad'), f'{name} returned {result.returncode}'
            run('systemctl', 'disable', '--now', 'empir3-bridge-update.timer', 'empir3-bridge-update.path')
            health = status(expected)
            retain_check()
            if name == 'bad':
                journal = run('journalctl', '-u', unit, '--since', '@' + started, '-o', 'json', '--no-pager').stdout
                events = [json.loads(line) for line in journal.splitlines() if line]
                restarts = [e for e in events if 'Scheduled restart job' in str(e.get('MESSAGE', ''))]
                assert 1 <= len(restarts) <= 5, f'Unexpected failed-update restart count: {len(restarts)}'
                health['boundedRestarts'] = len(restarts)
                state = json.loads(Path('/var/lib/empir3-bridge/update-state.json').read_text())
                assert state['lastStatus'] == 'failed'
                health['failureRecorded'] = True
            results.append({'step': name, **health})
    finally:
        server.shutdown()
        server.server_close()
    uninstall(purge=True)
    assert not Path('/home/empir3').exists()
    assert not Path('/var/lib/empir3-bridge').exists()
    assert run('getent', 'passwd', 'empir3', check=False).returncode != 0
    install(exact)
    status(candidate_version)
    assert not marker.exists()
    assert hashlib.sha256((current / 'trust/update-public-key.json').read_bytes()).hexdigest() == before['trustSha256']
    (receipts / 'lifecycle.json').write_text(json.dumps({
        'passed': True, 'arch': candidate_arch, 'originalVersion': candidate_version, 'sourceArchiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
        'normalUninstallRetainsState': True, 'reinstall': True, 'signedFixtureLifecycle': results,
        'purgeRemovesStateAndUser': True, 'productionTrustRestored': True,
        'fixtureVersions': '0.3.55/0.3.56/0.3.57 relabel the current runtime; ephemeral signing key, never release these',
    }, indent=2))
else:
    raise ValueError('Unknown acceptance phase')
print('PASS ' + phase)
