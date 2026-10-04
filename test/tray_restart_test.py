"""Exercise the actual restart method without importing tray startup side effects."""
import ast
import pathlib
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import Mock

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'tray' / 'tray.py'
TREE = ast.parse(SOURCE.read_text(encoding='utf-8-sig'))
TRAY = next(n for n in TREE.body if isinstance(n, ast.ClassDef) and n.name == 'EmpirTray')
METHOD = next(n for n in TRAY.body if isinstance(n, ast.FunctionDef) and n.name == '_restart_tray')


class InlineThread:
    def __init__(self, target, **kwargs):
        self.target = target

    def start(self):
        self.target()


class RestartTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.child = Mock()
        self.child.poll.return_value = None
        self.spawn = Mock(side_effect=lambda *a, **kw: self.spawn_child())
        self.handoff = Mock()
        self.handoff.environment.return_value = {'EMPIR3_TRAY_HANDOFF': 'fixture'}
        def ready(child):
            self.events.append('ready')
            if child.poll() is not None:
                raise RuntimeError('successor exited')
        self.handoff.wait_ready.side_effect = ready
        self.handoff.commit.side_effect = lambda: self.events.append('commit')
        self.path = Mock()
        self.path.__truediv__ = Mock(return_value=self.path)
        self.path.exists.return_value = True
        self.env = {'EMPIR3_BOOTSTRAP_EXE': 'C:/Empir3/Empir3Setup.exe'}
        namespace = {
            'PAYLOAD_ROOT': self.path,
            'get_active_payload_version': lambda: '0.3.109',
            'logger': Mock(),
            'threading': types.SimpleNamespace(Thread=InlineThread),
            'subprocess': types.SimpleNamespace(Popen=self.spawn),
            'time': types.SimpleNamespace(sleep=lambda _: None),
            'os': types.SimpleNamespace(environ=self.env),
            'CREATE_NO_WINDOW': 0x08000000,
            'TrayHandoff': lambda: self.handoff,
            '_INSTANCE_MUTEX_HANDLE': None,
            '_acquire_single_instance': lambda: True,
            '_release_instance_mutex': lambda: self.events.append('release'),
            '_bootstrap_from_pointer': lambda: '',
            '_bootstrap_from_autostart': lambda: '',
        }
        exec(compile(ast.Module(body=[METHOD], type_ignores=[]), str(SOURCE), 'exec'), namespace)
        self.restart = namespace['_restart_tray']
        self.tray = types.SimpleNamespace(
            _poller=Mock(), _supervisor=Mock(), _notify=Mock(),
            _clean_ports_on_final_stop=True, _restart_lock=threading.Lock(),
        )
        self.tray._poller.stop.side_effect = lambda: self.events.append('poller-stop')
        self.tray._supervisor.stop.side_effect = lambda **kw: self.events.append('daemon-stop')
        self.icon = Mock()
        self.icon.stop.side_effect = lambda: self.events.append('icon-stop')

    def spawn_child(self):
        self.events.append('spawn')
        return self.child

    def assert_running_preserved(self):
        self.tray._poller.stop.assert_not_called()
        self.tray._supervisor.stop.assert_not_called()
        self.icon.stop.assert_not_called()
        self.assertNotIn('release', self.events)
        self.assertTrue(self.tray._clean_ports_on_final_stop)

    def test_access_denied_preserves_current_daemon(self):
        self.spawn.side_effect = PermissionError('Windows blocked the successor')
        self.restart(self.tray, self.icon)
        self.assert_running_preserved()
        self.tray._notify.assert_called_once()

    def test_missing_successor_preserves_current_daemon(self):
        self.path.exists.return_value = False
        self.restart(self.tray, self.icon)
        self.spawn.assert_not_called()
        self.assert_running_preserved()

    def test_early_exit_preserves_current_daemon(self):
        self.child.poll.return_value = 1
        self.restart(self.tray, self.icon)
        self.assert_running_preserved()

    def test_successor_starts_before_current_daemon_is_stopped(self):
        self.restart(self.tray, self.icon, reopen_welcome=True)
        self.assertEqual(self.events, ['spawn', 'ready', 'poller-stop', 'daemon-stop', 'release', 'commit', 'icon-stop'])
        child_env = self.spawn.call_args.kwargs['env']
        self.assertEqual(child_env['EMPIR3_REOPEN_WELCOME_AFTER_UPDATE'], '1')
        self.assertEqual(child_env['EMPIR3_BOOTSTRAP_EXE'], self.env['EMPIR3_BOOTSTRAP_EXE'])
        self.assertEqual(child_env['PYINSTALLER_RESET_ENVIRONMENT'], '1')
        self.assertNotIn('PYINSTALLER_RESET_ENVIRONMENT', self.env)
        self.assertNotIn('EMPIR3_REOPEN_WELCOME_AFTER_UPDATE', self.env)

    def test_slow_or_hung_successor_preserves_current_daemon(self):
        self.handoff.wait_ready.side_effect = TimeoutError('not ready')
        self.restart(self.tray, self.icon)
        self.assert_running_preserved()
        self.child.terminate.assert_called_once()
        self.handoff.close.assert_called()

    def test_lost_commit_connection_recovers_current_daemon(self):
        self.handoff.commit.side_effect = ConnectionError('replacement disappeared')
        self.restart(self.tray, self.icon)
        self.tray._supervisor.start.assert_called_once()
        self.tray._poller.start.assert_called_once()
        self.icon.stop.assert_not_called()
        self.assertTrue(self.tray._clean_ports_on_final_stop)

    def test_duplicate_restart_is_ignored_until_first_finishes(self):
        self.tray._restart_lock.acquire()
        self.restart(self.tray, self.icon)
        self.spawn.assert_not_called()
        self.tray._restart_lock.release()

    def test_real_os_launch_refusal_preserves_current_daemon(self):
        # A directory is never an executable. Exercise a real OS refusal
        # without touching the installed or quarantined tray.
        with tempfile.TemporaryDirectory(prefix='empir3-tray-test-') as directory:
            self.spawn.side_effect = lambda *a, **kw: subprocess.Popen([directory])
            self.restart(self.tray, self.icon)
        self.assert_running_preserved()
        self.tray._notify.assert_called_once()

    def test_real_child_exit_preserves_current_daemon(self):
        child = subprocess.Popen([sys.executable, '-c', 'raise SystemExit(7)'])
        try:
            child.wait(timeout=5)
            self.spawn.side_effect = lambda *a, **kw: child
            self.restart(self.tray, self.icon)
            self.assert_running_preserved()
        finally:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)


class StartupTests(unittest.TestCase):
    def setUp(self):
        method = next(n for n in TRAY.body if isinstance(n, ast.FunctionDef) and n.name == 'run')
        self.icon = Mock()
        self.acquire = Mock(return_value=True)
        self.release = Mock()
        self.handoff = Mock(return_value=True)
        self.icon_factory = Mock(return_value=self.icon)
        namespace = dict(logger=Mock(), sys=types.SimpleNamespace(frozen=False),
                         pystray=types.SimpleNamespace(Icon=self.icon_factory),
                         _create_icon_image=Mock(), accept_tray_handoff=self.handoff,
                         _acquire_single_instance=self.acquire, _release_instance_mutex=self.release,
                         os=types.SimpleNamespace(environ={}),
                         _record_tray_version_and_detect_transition=lambda _: False)
        exec(compile(ast.Module(body=[method], type_ignores=[]), str(SOURCE), 'exec'), namespace)
        self.run_tray = namespace['run']
        self.tray = types.SimpleNamespace(_tray_version='fixture', _menu=Mock(),
                                         _supervisor=Mock(), _poller=Mock(), _updater=Mock(),
                                         _clean_ports_on_final_stop=True)

    def test_cancelled_handoff_never_takes_ownership(self):
        self.handoff.return_value = False
        self.run_tray(self.tray)
        self.acquire.assert_not_called()
        self.tray._supervisor.start.assert_not_called()

    def test_failed_icon_initialization_never_reports_ready(self):
        self.icon_factory.side_effect = RuntimeError('icon initialization failed')
        with self.assertRaises(RuntimeError):
            self.run_tray(self.tray)
        self.handoff.assert_not_called()
        self.tray._supervisor.start.assert_not_called()

    def test_failure_after_daemon_start_cleans_up_and_releases_ownership(self):
        self.tray._poller.start.side_effect = RuntimeError('poller initialization failed')
        with self.assertRaises(RuntimeError):
            self.run_tray(self.tray)
        self.tray._supervisor.stop.assert_called_once_with(clean_ports=True)
        self.release.assert_called_once()

    def test_successful_run_stops_all_workers_and_releases_ownership(self):
        self.run_tray(self.tray)
        for worker in (self.tray._supervisor, self.tray._poller, self.tray._updater):
            worker.start.assert_called_once()
            worker.stop.assert_called_once()
        self.release.assert_called_once()


if __name__ == '__main__':
    unittest.main()
