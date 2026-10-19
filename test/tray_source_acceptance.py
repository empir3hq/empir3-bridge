"""Windows source acceptance with real tray icons and disposable daemon children.

No installed Bridge processes, profiles, ports, updater, or credentials are used.
The successor executable boundary launches this source harness, not a package.
"""
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import time
import types
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]


def event(kind, **fields):
    with open(pathlib.Path(os.environ['TRAY_TEST_ROOT']) / 'events.jsonl', 'a', encoding='utf-8') as stream:
        stream.write(json.dumps(dict(kind=kind, role=os.environ.get('TRAY_TEST_ROLE'),
                                     pid=os.getpid(), time=time.time(), **fields)) + '\n')


def role_main(role):
    directory = pathlib.Path(os.environ['TRAY_TEST_ROOT'])
    sys.path.insert(0, str(ROOT / 'tray'))
    spec = importlib.util.spec_from_file_location('acceptance_tray', ROOT / 'tray' / 'tray.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    from tray_handoff import WindowsInstanceLease
    module.WindowsInstanceLease = lambda: WindowsInstanceLease(os.environ['TRAY_TEST_MUTEX'])
    module.cleanup_bridge_owned_processes = lambda *_: 0
    module._record_tray_version_and_detect_transition = lambda *_: False
    module.get_active_payload_version = lambda: 'candidate'
    module.PAYLOAD_ROOT = directory / 'payload'
    fixture_exe = module.PAYLOAD_ROOT / 'candidate' / 'Empir3Tray.exe'
    fixture_exe.parent.mkdir(parents=True, exist_ok=True)
    fixture_exe.touch()
    children = []
    def spawn(args, **kwargs):
        if args == [str(fixture_exe)]:
            env = {**kwargs['env'], 'TRAY_TEST_ROLE': 'successor'}
            kwargs['env'] = env
            args = [sys.executable, str(pathlib.Path(__file__).resolve()), '--role', 'successor']
        proc = subprocess.Popen(args, **kwargs)
        children.append(proc)
        return proc
    module.subprocess = types.SimpleNamespace(**{**vars(subprocess), 'Popen': spawn})
    tray = module.EmpirTray()
    tray._tray_version = 'source-' + role
    tray._updater = types.SimpleNamespace(start=lambda: None, stop=lambda: None)
    tray._poller._poll_once = lambda: {'reachable': False, 'port': None}
    tray._supervisor._spawn_args = lambda: [sys.executable, '-c', 'import time; time.sleep(30)']
    original_state = tray._supervisor._on_state_change
    def state(kind, detail):
        original_state(kind, detail)
        if kind == 'running':
            event('daemon-running', child=tray._supervisor.child_pid)
        elif kind == 'exited':
            event('daemon-exited')
    tray._supervisor._on_state_change = state
    if role == 'successor':
        # Deliberately longer than the old 0.5-second survival check.
        time.sleep(1)
        if os.environ.get('TRAY_TEST_SCENARIO') == 'crash':
            event('successor-startup-crash')
            raise SystemExit(17)
    finished = threading.Event()
    def drive():
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline and not finished.is_set():
            if tray._supervisor.child_pid:
                if role == 'parent':
                    original_pid = tray._supervisor.child_pid
                    event('restart-requested')
                    tray._restart_tray(tray._icon)
                    if os.environ.get('TRAY_TEST_SCENARIO') == 'crash':
                        while tray._restart_lock.locked() and time.monotonic() < deadline:
                            time.sleep(0.02)
                        if tray._supervisor.child_pid == original_pid:
                            event('current-daemon-preserved', child=original_pid)
                        tray._icon.stop()
                else:
                    time.sleep(0.5)
                    tray._icon.stop()
                return
            time.sleep(0.02)
    def watchdog():
        if not finished.wait(18):
            event('watchdog-timeout')
            if tray._icon:
                tray._icon.stop()
    threading.Thread(target=drive, daemon=True).start()
    threading.Thread(target=watchdog, daemon=True).start()
    try:
        tray.run()
        event('tray-stopped')
    finally:
        finished.set()
        for child in children:
            try:
                child.wait(timeout=12)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=3)
                event('forced-child-cleanup', child=child.pid)


def acceptance_main(scenario='success'):
    if sys.platform != 'win32':
        raise SystemExit('This acceptance requires Windows')
    with tempfile.TemporaryDirectory(prefix='empir3-source-tray-') as directory:
        env = {**os.environ, 'TRAY_TEST_ROOT': directory, 'TRAY_TEST_ROLE': 'parent',
               'TRAY_TEST_MUTEX': 'Local\\Empir3SourceAcceptance-' + uuid.uuid4().hex,
               'TRAY_TEST_SCENARIO': scenario,
               'APPDATA': directory, 'USERPROFILE': directory}
        env.pop('EMPIR3_TRAY_HANDOFF', None)
        result = subprocess.run([sys.executable, str(pathlib.Path(__file__).resolve()), '--role', 'parent'],
                                env=env, capture_output=True, text=True, timeout=40,
                                creationflags=subprocess.CREATE_NO_WINDOW)
        rows = [json.loads(line) for line in (pathlib.Path(directory) / 'events.jsonl').read_text().splitlines()]
        assert result.returncode == 0, result.stderr[-2000:]
        assert not any(r['kind'] in ('watchdog-timeout', 'forced-child-cleanup') for r in rows), rows
        if scenario == 'crash':
            assert any(r['kind'] == 'successor-startup-crash' for r in rows), rows
            assert any(r['kind'] == 'current-daemon-preserved' for r in rows), rows
            assert len([r for r in rows if r['kind'] == 'daemon-running']) == 1, rows
            print(json.dumps({'passed': True, 'scenario': scenario, 'events': rows}, indent=2))
            return
        old_exit = next(r for r in rows if r['kind'] == 'daemon-exited' and r['role'] == 'parent')
        new_start = next(r for r in rows if r['kind'] == 'daemon-running' and r['role'] == 'successor')
        assert old_exit['time'] <= new_start['time'], rows
        assert len([r for r in rows if r['kind'] == 'daemon-running']) == 2, rows
        assert len([r for r in rows if r['kind'] == 'daemon-exited']) == 2, rows
        assert len([r for r in rows if r['kind'] == 'tray-stopped']) == 2, rows
        print(json.dumps({'passed': True, 'mode': 'Windows source with real pystray and child processes',
                          'events': rows, 'daemonHandoffGapMs': round(1000 * (new_start['time'] - old_exit['time']))}, indent=2))


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--role':
        role_main(sys.argv[2])
    else:
        acceptance_main(sys.argv[2] if len(sys.argv) > 2 else 'success')
