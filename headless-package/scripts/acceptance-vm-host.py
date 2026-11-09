"""Verify an exact Linux archive in an offline disposable QEMU guest."""
import argparse
import hashlib
import json
import os
import platform
import re
from pathlib import Path, PurePosixPath
import shutil
import socket
import subprocess
import sys
import tempfile
import tarfile
import time
import urllib.request
import uuid

if not __debug__:
    raise RuntimeError('Optimized Python would disable acceptance guards')
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('archive', type=Path)
parser.add_argument('--candidate-receipt', type=Path,
                    help='JSON with archiveSha256, version and candidateSource for the exact candidate')
parser.add_argument('--local-disposable', action='store_true',
                    help='Explicitly allow this QEMU-only harness on a local Linux development host')
parser.add_argument('--image-file', type=Path,
                    help='Pre-downloaded Ubuntu image; the pinned SHA-256 is still mandatory')
parser.add_argument('--guest-node', type=Path,
                    help='Explicit Node binary for a guest architecture different from the host')
parser.add_argument('--guest-node-sha256',
                    help='Required SHA-256 when an explicit guest Node binary is supplied')
args = parser.parse_args()
assert sys.platform == 'linux'
assert os.environ.get('GITHUB_ACTIONS') == 'true' or args.local_disposable, 'Explicit local disposable-VM mode is required outside CI'
assert os.geteuid() != 0, 'Do not run this harness as root'
script = Path(__file__).resolve()
assert script.parents[1].name == 'headless-package'
repo = script.parents[2]
archive = args.archive.resolve()
# Preserve the historical held-candidate workflow; new candidates require an
# explicit identity receipt instead of silently accepting arbitrary bytes.
identity = json.loads(args.candidate_receipt.read_text()) if args.candidate_receipt else {
    'archiveSha256': 'b93c28d13c2e522d9e7d8de98688e3e568c8b7088186b05d0a30d53d049240ac',
    'version': '0.4.11', 'candidateSource': '9a1cc8a293dbba563a3b331822289443e5e53829',
}
assert re.fullmatch(r'[0-9a-f]{64}', identity['archiveSha256'])
assert re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', identity['version'])
assert re.fullmatch(r'[0-9a-f]{40}', identity['candidateSource'])
assert hashlib.sha256(archive.read_bytes()).hexdigest() == identity['archiveSha256'], 'Candidate archive hash mismatch'
with tarfile.open(archive) as candidate_tar:
    metadata = json.load(candidate_tar.extractfile('package-metadata.json'))
assert metadata['version'] == identity['version'] and metadata['platform'] == 'linux'
arch = identity.get('arch', 'x64')
assert arch in ('x64', 'arm64') and metadata['arch'] == arch, 'Candidate architecture mismatch'
assert bool(args.guest_node) == bool(args.guest_node_sha256), 'Explicit guest Node requires its SHA-256'
guest_node = args.guest_node.resolve() if args.guest_node else Path(shutil.which('node')).resolve()
node_bytes = guest_node.read_bytes()
node_digest = hashlib.sha256(node_bytes).hexdigest()
if args.guest_node:
    assert re.fullmatch(r'[0-9a-f]{64}', args.guest_node_sha256)
    assert node_digest == args.guest_node_sha256, 'Guest Node hash mismatch'
assert node_bytes[:6] == b'\x7fELF\x02\x01', 'Guest Node must be a 64-bit little-endian ELF binary'
assert int.from_bytes(node_bytes[18:20], 'little') == {'x64': 62, 'arm64': 183}[arch], 'Guest Node architecture mismatch'
del node_bytes
runner_temp = Path(os.environ['RUNNER_TEMP']).resolve()
assert runner_temp.is_dir() and runner_temp != Path('/')
evidence = repo / 'headless-evidence'
evidence.mkdir(exist_ok=False)
nonce = str(uuid.uuid4())


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, timeout=kwargs.pop('timeout', 180), **kwargs)


with tempfile.TemporaryDirectory(prefix='empir3-headless-vm-', dir=runner_temp) as temporary:
    work = Path(temporary)
    image = work / 'ubuntu.img'
    image_arch, image_sha = {
        'x64': ('amd64', 'bc9237bfdfa42b5f9a4404b6c6cab595d3e57599c6498f6664ad00e6192f9595'),
        'arm64': ('arm64', 'dc805610db0bcaef6d2b34c4737a4697e804773da41e002a1362f40b9bf7e674'),
    }[arch]
    url = f'https://cloud-images.ubuntu.com/minimal/releases/noble/release-20261103/ubuntu-24.04-minimal-cloudimg-{image_arch}.img'
    if args.image_file:
        shutil.copyfile(args.image_file.resolve(), image)
    else:
        with urllib.request.urlopen(url, timeout=90) as response, image.open('wb') as output:
            shutil.copyfileobj(response, output)
    digest = hashlib.sha256(image.read_bytes()).hexdigest()
    assert digest == image_sha
    (evidence / 'input.json').write_text(json.dumps({'imageUrl': url, 'imageSha256': digest,
        **identity, 'arch': arch, 'guestNodeSha256': node_digest,
        'mode': 'local-disposable' if args.local_disposable else 'github-actions',
        'guestExternalNetwork': 'blocked by QEMU restrict=on', 'nodeVersion': subprocess.check_output(['node', '--version'], text=True).strip()}, indent=2))
    key = work / 'ssh-key'
    run('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key))
    userdata = work / 'user-data'
    userdata.write_text('#cloud-config\n' + json.dumps({
        'hostname': 'empir3-security-ci', 'manage_etc_hosts': True, 'ssh_pwauth': False,
        'users': [{'name': 'acceptance', 'sudo': 'ALL=(ALL) NOPASSWD:ALL', 'shell': '/bin/bash',
                   'lock_passwd': True, 'ssh_authorized_keys': [(work / 'ssh-key.pub').read_text().strip()]}],
        'write_files': [{'path': '/etc/empir3-acceptance-only', 'permissions': '0600', 'content': nonce}],
        'package_update': False, 'package_upgrade': False,
    }))
    metadata = work / 'meta-data'
    metadata.write_text('instance-id: ' + nonce + '\nlocal-hostname: empir3-security-ci\n')
    seed = work / 'seed.img'
    run('cloud-localds', str(seed), str(userdata), str(metadata))
    disk = work / 'disk.qcow2'
    run('qemu-img', 'create', '-f', 'qcow2', '-F', 'qcow2', '-b', str(image), str(disk), '12G')
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    ssh = ['ssh', '-i', str(key), '-p', str(port), '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
           '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', '-o', 'StrictHostKeyChecking=accept-new',
           '-o', 'UserKnownHostsFile=' + str(work / 'known_hosts'), 'acceptance@127.0.0.1']
    host_matches_guest = platform.machine() in {'x64': ('x86_64', 'amd64'), 'arm64': ('aarch64', 'arm64')}[arch]
    accelerator = 'kvm' if host_matches_guest and os.access('/dev/kvm', os.R_OK | os.W_OK) else 'tcg'
    qemu_log = (evidence / 'qemu.log').open('w')
    machine = ['qemu-system-x86_64'] if arch == 'x64' else [
        'qemu-system-aarch64', '-machine', 'virt', '-cpu', 'host' if accelerator == 'kvm' else 'cortex-a72',
        '-bios', '/usr/share/qemu-efi-aarch64/QEMU_EFI.fd',
    ]
    # ARM boots from the pinned disk, never PXE; the optional x86 EFI network
    # ROM is neither needed nor shipped by minimal qemu-system-arm installs.
    network_device = 'virtio-net-pci,netdev=net0' + (',romfile=' if arch == 'arm64' else '')
    vm = subprocess.Popen([*machine, '-m', '2048', '-smp', '2', '-accel', accelerator,
        '-drive', f'file={disk},if=virtio,format=qcow2', '-drive', f'file={seed},if=virtio,format=raw',
        '-netdev', f'user,id=net0,restrict=on,hostfwd=tcp:127.0.0.1:{port}-:22', '-device', network_device,
        '-display', 'none', '-serial', 'stdio', '-monitor', 'none'], stdout=qemu_log, stderr=subprocess.STDOUT)
    def wait_ssh():
        deadline = time.monotonic() + 480
        while time.monotonic() < deadline:
            assert vm.poll() is None, 'QEMU stopped before SSH became available'
            try:
                result = subprocess.run(ssh + ['true'], capture_output=True, timeout=8)
            except subprocess.TimeoutExpired:
                # A boot-time SSH observation timeout says nothing about VM
                # liveness. Keep waiting on this same owned QEMU process.
                continue
            if result.returncode == 0:
                return
            time.sleep(2)
        raise TimeoutError('Guest SSH did not become ready')
    def remote(command, **kwargs):
        return run(*ssh, command, **kwargs)
    try:
        wait_ssh()
        remote('cloud-init status --wait', timeout=120)
        payload = work / 'input'
        payload.mkdir()
        shutil.copy2(archive, payload / 'candidate.tar.gz')
        (payload / 'candidate-identity.json').write_text(json.dumps({**identity, 'arch': arch}))
        shutil.copy2(guest_node, payload / 'node')
        shutil.copy2(repo / 'headless-package/scripts/acceptance-vm-guest.py', payload / 'guest.py')
        run('node', str(repo / 'headless-package/scripts/create-update-acceptance-fixture.cjs'),
            '--base-archive', str(archive), '--out', str(payload / 'fixture'), stdout=subprocess.DEVNULL)
        # Only synthetic fixtures and a Node binary enter the guest. No repo, CI token or operator keys.
        transfer = subprocess.Popen(['tar', '-C', str(work), '-czf', '-', 'input'], stdout=subprocess.PIPE)
        try:
            remote('tar -xzf - -C /home/acceptance', stdin=transfer.stdout)
        finally:
            transfer.stdout.close()
            assert transfer.wait(timeout=30) == 0
        remote('sudo install -m 0755 /home/acceptance/input/node /usr/local/bin/node')
        remote('sudo python3 /home/acceptance/input/guest.py install ' + nonce)
        # Reboot kills this SSH connection by design. Check the next boot ID in the guest.
        subprocess.run(ssh + ['sudo systemctl reboot'], capture_output=True, timeout=15)
        time.sleep(5)
        wait_ssh()
        remote('sudo python3 /home/acceptance/input/guest.py after-reboot ' + nonce)
        remote('sudo python3 /home/acceptance/input/guest.py lifecycle ' + nonce, timeout=360)
    finally:
        if vm.poll() is None:
            # Preserve only receipts; never upload guest disks, SSH keys or synthetic release archives.
            try:
                transfer = subprocess.run(ssh + ['sudo tar -czf - -C /home/acceptance/input receipts'], capture_output=True, timeout=20)
                if transfer.returncode == 0:
                    import io, tarfile
                    # Receipt-only extraction also works on Python 3.11 hosts.
                    # Never materialize guest symlinks, devices, modes or owners.
                    with tarfile.open(fileobj=io.BytesIO(transfer.stdout)) as source:
                        total = 0
                        for member in source:
                            parts = PurePosixPath(member.name).parts
                            assert parts and parts[0] == 'receipts' and '..' not in parts and '\\' not in member.name
                            if member.isdir():
                                continue
                            assert member.isfile() and len(parts) > 1 and 0 <= member.size <= 16 * 1024 * 1024
                            total += member.size
                            assert total <= 64 * 1024 * 1024
                            output = evidence.joinpath(*parts)
                            assert output.resolve().is_relative_to(evidence.resolve())
                            output.parent.mkdir(parents=True, exist_ok=True)
                            with source.extractfile(member) as incoming, output.open('xb') as destination:
                                shutil.copyfileobj(incoming, destination)
            except (OSError, subprocess.SubprocessError) as error:
                print('Could not collect guest receipts: ' + type(error).__name__, file=sys.stderr)
            finally:
                vm.terminate()
                try:
                    vm.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    vm.kill()
                    vm.wait(timeout=10)
        qemu_log.close()
print('PASS isolated headless systemd VM acceptance')
