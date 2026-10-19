"""Real subprocess, loopback, and Windows mutex handoff acceptance."""
import os
import pathlib
import socket
import subprocess
import sys
import threading
import time
import unittest
import uuid

TRAY = pathlib.Path(__file__).resolve().parents[1] / 'tray'
sys.path.insert(0, str(TRAY))
from tray_handoff import TrayHandoff, WindowsInstanceLease, accept_tray_handoff


class HandoffTests(unittest.TestCase):
    def child(self, handoff, delay=0):
        env = {**os.environ, **handoff.environment(), 'PYTHONPATH': str(TRAY)}
        return subprocess.Popen([
            sys.executable, '-c',
            f'import time; time.sleep({delay}); from tray_handoff import accept_tray_handoff; '
            'raise SystemExit(0 if accept_tray_handoff(timeout=3) else 7)',
        ], env=env, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))

    def finish(self, handoff, child):
        handoff.close()
        try:
            child.wait(timeout=4)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=3)

    def test_delayed_real_child_waits_for_commit(self):
        handoff = TrayHandoff()
        child = self.child(handoff, delay=0.7)
        try:
            started = time.monotonic()
            handoff.wait_ready(child, timeout=3)
            self.assertGreater(time.monotonic() - started, 0.5)
            self.assertIsNone(child.poll())
            handoff.commit()
            self.assertEqual(child.wait(timeout=3), 0)
        finally:
            self.finish(handoff, child)

    def test_parent_cancellation_makes_ready_child_exit(self):
        handoff = TrayHandoff()
        child = self.child(handoff)
        try:
            handoff.wait_ready(child, timeout=3)
            handoff.close()
            self.assertEqual(child.wait(timeout=3), 7)
        finally:
            self.finish(handoff, child)

    def test_startup_timeout_never_commits(self):
        handoff = TrayHandoff()
        child = self.child(handoff, delay=0.6)
        try:
            with self.assertRaises(TimeoutError):
                handoff.wait_ready(child, timeout=0.1)
            with self.assertRaises(RuntimeError):
                handoff.commit()
        finally:
            self.finish(handoff, child)

    def test_wrong_local_client_cannot_authorize_handoff(self):
        handoff = TrayHandoff()
        child = self.child(handoff, delay=0.3)
        try:
            port = int(handoff.environment()['EMPIR3_TRAY_HANDOFF'].split(':')[0])
            with socket.create_connection(('127.0.0.1', port)) as connection:
                connection.sendall(b'ready:wrong\n')
            handoff.wait_ready(child, timeout=3)
            handoff.commit()
            self.assertEqual(child.wait(timeout=3), 0)
        finally:
            self.finish(handoff, child)

    def test_normal_startup_and_invalid_descriptor(self):
        self.assertTrue(accept_tray_handoff({}))
        self.assertFalse(accept_tray_handoff({'EMPIR3_TRAY_HANDOFF': 'invalid'}))


@unittest.skipUnless(sys.platform == 'win32', 'Windows mutex acceptance')
class InstanceTests(unittest.TestCase):
    def test_real_mutex_excludes_duplicate_and_releases_from_worker(self):
        name = 'Local\\Empir3TrayTest-' + uuid.uuid4().hex
        first, duplicate = WindowsInstanceLease(name), WindowsInstanceLease(name)
        successor = WindowsInstanceLease(name)
        try:
            self.assertTrue(first.acquire(timeout=1), first.error)
            self.assertFalse(duplicate.acquire(timeout=0.1))
            result = []
            waiter = threading.Thread(target=lambda: result.append(successor.acquire(timeout=2)))
            waiter.start()
            closer = threading.Thread(target=first.close)
            closer.start()
            closer.join(3)
            waiter.join(3)
            self.assertEqual(result, [True], successor.error)
            self.assertIsNone(first.error)
        finally:
            first.close()
            duplicate.close()
            successor.close()

    def test_dead_owner_releases_mutex_for_next_process(self):
        name = 'Local\\Empir3TrayTest-' + uuid.uuid4().hex
        env = {**os.environ, 'PYTHONPATH': str(TRAY), 'TEST_MUTEX_NAME': name}
        child = subprocess.Popen([
            sys.executable, '-c',
            'import os,time; from tray_handoff import WindowsInstanceLease; '
            'lease=WindowsInstanceLease(os.environ["TEST_MUTEX_NAME"]); '
            'print(lease.acquire(1),flush=True); time.sleep(30)',
        ], env=env, stdout=subprocess.PIPE, text=True,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        successor = WindowsInstanceLease(name)
        try:
            self.assertEqual(child.stdout.readline().strip(), 'True')
            child.kill()
            child.wait(timeout=3)
            self.assertTrue(successor.acquire(timeout=1), successor.error)
        finally:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=3)
            child.stdout.close()
            successor.close()


if __name__ == '__main__':
    unittest.main()
