"""Isolated daemon lifecycle tests; never starts the installed bridge."""
import ast
import logging
import pathlib
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from typing import Optional
from unittest.mock import Mock

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'tray' / 'tray.py'
TREE = ast.parse(SOURCE.read_text(encoding='utf-8-sig'))


def load_class(name, **extra):
    node = next(n for n in TREE.body if isinstance(n, ast.ClassDef) and n.name == name)
    namespace = dict(threading=threading, subprocess=subprocess, Optional=Optional,
                     Path=pathlib.Path, time=time, logger=logging.getLogger('test'),
                     CREATE_NO_WINDOW=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
                     RESTART_BACKOFF_SEC=[0], STATUS_POLL_SEC=0.01,
                     cleanup_bridge_owned_processes=lambda *_: 0,
                     _attach_to_job=lambda *_: False)
    namespace.update(extra)
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(SOURCE), 'exec'), namespace)
    return namespace[name], namespace


class SupervisorTests(unittest.TestCase):
    def test_stop_during_argument_resolution_never_spawns(self):
        with tempfile.TemporaryDirectory(prefix='empir3-supervisor-') as directory:
            cls, namespace = load_class('DaemonSupervisor', BRIDGE_LOG=pathlib.Path(directory) / 'log')
            supervisor = cls()
            entered, release = threading.Event(), threading.Event()
            fake_proc = Mock()
            fake_proc.wait.return_value = 0
            spawn = Mock(return_value=fake_proc)
            namespace['subprocess'] = types.SimpleNamespace(Popen=spawn, STDOUT=-2, DEVNULL=-3)
            def resolve():
                entered.set()
                release.wait(3)
                return ['fixture']
            supervisor._spawn_args = resolve
            supervisor.start()
            self.assertTrue(entered.wait(2))
            stopper = threading.Thread(target=lambda: supervisor.stop(clean_ports=False))
            stopper.start()
            deadline = time.monotonic() + 2
            while not supervisor._stop_requested and time.monotonic() < deadline:
                time.sleep(0.001)
            release.set()
            stopper.join(3)
            supervisor._supervise_thread.join(3)
            self.assertFalse(supervisor._supervise_thread.is_alive())
            spawn.assert_not_called()

    def test_real_child_crash_respawns_and_stop_leaves_no_child(self):
        with tempfile.TemporaryDirectory(prefix='empir3-supervisor-') as directory:
            cls, _ = load_class('DaemonSupervisor', BRIDGE_LOG=pathlib.Path(directory) / 'log')
            running = threading.Event()
            supervisor = cls()
            children = []
            def resolve():
                # Crash the first process, then keep the replacement alive.
                code = 'raise SystemExit(9)' if supervisor._spawn_count == 0 else 'import time; time.sleep(30)'
                return [sys.executable, '-c', code]
            supervisor._spawn_args = resolve
            def changed(state, detail):
                if state == 'running':
                    children.append(supervisor._proc)
                    if len(children) == 2:
                        running.set()
            supervisor._on_state_change = changed
            try:
                supervisor.start()
                first_thread = supervisor._supervise_thread
                supervisor.start()
                self.assertIs(first_thread, supervisor._supervise_thread)
                self.assertTrue(running.wait(5), 'crashed daemon did not restart')
                supervisor.stop(clean_ports=False)
                self.assertFalse(supervisor._supervise_thread.is_alive())
                self.assertIsNone(supervisor.child_pid)
                self.assertEqual(len(children), 2)
            finally:
                supervisor.stop(clean_ports=False)
                for child in children:
                    if child.poll() is None:
                        child.kill()
                    child.wait(timeout=3)


class PollerTests(unittest.TestCase):
    def test_stop_suppresses_inflight_status_and_commands(self):
        cls, _ = load_class('StatusPoller')
        status, commands = Mock(), Mock()
        poller = cls(status, commands)
        entered, release = threading.Event(), threading.Event()
        def poll():
            entered.set()
            release.wait(3)
            return {'reachable': True, 'port': 12345}
        poller._poll_once = poll
        poller._drain_tray_commands = Mock(return_value=[{'type': 'fixture'}])
        poller.start()
        self.assertTrue(entered.wait(2))
        poller.stop()
        release.set()
        poller._thread.join(3)
        status.assert_not_called()
        commands.assert_not_called()
        poller._drain_tray_commands.assert_not_called()

    def test_duplicate_start_does_not_create_second_poller(self):
        cls, _ = load_class('StatusPoller')
        poller = cls(Mock())
        release = threading.Event()
        def poll():
            release.wait(3)
            return {}
        poller._poll_once = poll
        poller.start()
        first = poller._thread
        try:
            poller.start()
            self.assertIs(first, poller._thread)
        finally:
            poller.stop()
            release.set()
            first.join(3)
            poller._thread.join(3)


if __name__ == '__main__':
    unittest.main()
