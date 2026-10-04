"""Two-phase local tray startup: ready first, release current daemon second."""
import hmac
import os
import secrets
import socket
import threading
import time

HANDOFF_ENV = 'EMPIR3_TRAY_HANDOFF'


class WindowsInstanceLease:
    """A mutex acquired and released by the same dedicated Windows thread."""

    def __init__(self, name=r'Local\Empir3BridgeTray'):
        self.name = name
        self._release = threading.Event()
        self._ready = threading.Event()
        self._thread = None
        self._acquired = False
        self.error = None

    def acquire(self, timeout=15):
        if self._thread is not None:
            raise RuntimeError('instance lease cannot be acquired twice')
        self._thread = threading.Thread(target=self._own, args=(timeout,), daemon=True)
        self._thread.start()
        if not self._ready.wait(timeout + 2):
            self._release.set()
            return False
        return self._acquired

    def _own(self, timeout):
        handle, owned = None, False
        try:
            import ctypes
            from ctypes import wintypes
            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            kernel.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
            kernel.CreateMutexW.restype = wintypes.HANDLE
            kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            kernel.WaitForSingleObject.restype = wintypes.DWORD
            kernel.ReleaseMutex.argtypes = [wintypes.HANDLE]
            kernel.ReleaseMutex.restype = wintypes.BOOL
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel.CloseHandle.restype = wintypes.BOOL
            handle = kernel.CreateMutexW(None, False, self.name)
            if not handle:
                raise ctypes.WinError(ctypes.get_last_error())
            deadline = time.monotonic() + timeout
            while not self._release.is_set():
                remaining = max(0, deadline - time.monotonic())
                result = kernel.WaitForSingleObject(handle, min(100, int(remaining * 1000)))
                if result in (0, 0x80):  # acquired or abandoned by a dead owner
                    owned = True
                    self._acquired = True
                    self._ready.set()
                    self._release.wait()
                    return
                if result != 0x102:
                    raise ctypes.WinError(ctypes.get_last_error())
                if time.monotonic() >= deadline:
                    return
        except Exception as error:
            self.error = error
        finally:
            if handle:
                if owned and not kernel.ReleaseMutex(handle):
                    self.error = ctypes.WinError(ctypes.get_last_error())
                kernel.CloseHandle(handle)
            self._ready.set()

    def close(self):
        self._release.set()
        if self._thread:
            self._thread.join(timeout=2)
            if self._thread.is_alive():
                raise RuntimeError('instance lease thread failed to release')
        if self.error:
            raise self.error


def _line(connection, maximum=256):
    data = bytearray()
    while len(data) < maximum:
        byte = connection.recv(1)
        if not byte:
            raise ConnectionError('tray handoff connection closed')
        if byte == b'\n':
            return data.decode('ascii')
        data.extend(byte)
    raise ValueError('tray handoff message is too long')


class TrayHandoff:
    """Ephemeral loopback channel authenticated to the one spawned successor.

    Closing without commit tells a waiting successor to exit. No installed
    settings, shared filenames, or fixed listening port are involved.
    """

    def __init__(self):
        self._listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            self._listener.bind(('127.0.0.1', 0))
            self._listener.listen(4)
        except BaseException:
            self._listener.close()
            raise
        self._token = secrets.token_hex(24)
        self._connection = None

    def environment(self):
        return {HANDOFF_ENV: f'{self._listener.getsockname()[1]}:{self._token}'}

    def wait_ready(self, successor, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if successor.poll() is not None:
                raise RuntimeError('replacement tray exited before reporting ready')
            self._listener.settimeout(min(0.1, max(0.001, deadline - time.monotonic())))
            try:
                connection, _ = self._listener.accept()
            except socket.timeout:
                continue
            try:
                connection.settimeout(min(1, max(0.001, deadline - time.monotonic())))
                if not hmac.compare_digest(_line(connection), 'ready:' + self._token):
                    connection.close()
                    continue
                if successor.poll() is not None:
                    raise RuntimeError('replacement tray exited during readiness check')
                self._connection = connection
                return
            except (OSError, UnicodeError, ValueError):
                connection.close()
            except BaseException:
                connection.close()
                raise
        raise TimeoutError('replacement tray did not report ready within the startup deadline')

    def commit(self):
        if self._connection is None:
            raise RuntimeError('replacement tray has not reported ready')
        self._connection.sendall(b'continue\n')

    def close(self):
        if self._connection is not None:
            self._connection.close()
            self._connection = None
        self._listener.close()


def accept_tray_handoff(environment=None, timeout=90):
    """Called after successor initialization, before taking daemon ownership.

    An ordinary startup has no handoff. A successor waits for explicit commit;
    timeout or parent death returns False without starting any daemon.
    """
    environment = os.environ if environment is None else environment
    descriptor = environment.pop(HANDOFF_ENV, '')
    if not descriptor:
        return True
    try:
        port, token = descriptor.split(':', 1)
        if len(token) != 48 or any(c not in '0123456789abcdef' for c in token):
            return False
        with socket.create_connection(('127.0.0.1', int(port)), timeout=5) as connection:
            connection.settimeout(timeout)
            connection.sendall(('ready:' + token + '\n').encode('ascii'))
            return _line(connection) == 'continue'
    except (OSError, ValueError, UnicodeError):
        return False
