"""
Empir3 Bridge — System Tray wrapper.

A thin Python wrapper that gives the headless Node bridge daemon a real
desktop surface: tray icon, right-click menu, status indicator, log viewer.

Architecture:
  - This process owns the tray. The bridge daemon is a child.
  - Spawns `Empir3Setup.exe --daemon-real` (or `node bridge/index.js` in dev)
    as a hidden subprocess. Restarts on crash with exponential backoff.
  - Polls http://127.0.0.1:<port>/api/relay-status every 2s on each of the
    bridge's candidate ports (3006/3106/3206/3306) to find the live daemon
    and read its connection state.
  - Surfaces connection state via icon color (green=connected, red=down)
    and a disabled "● Connected" / "○ Disconnected" menu line.

Menu:
  Empir3 — <device name>           (header, disabled)
  ● Connected · <user email>       (status, disabled)
  ──────────────────────────────
  Open app.empir3.com              browser opens https://app.empir3.com
  Open log                         opens %APPDATA%/Empir3/bridge.log
  ──────────────────────────────
  Reconnect daemon                 SIGTERM child + respawn
  Sign out                         delete bridge-auth.json + open installer
  ──────────────────────────────
  Quit Empir3                      kill child, exit tray

Dev:
  python bridge/tray/tray.py
    → spawns `node <repo>/bridge/index.js` as child, polls local ports.

Production (PyInstaller'd as Empir3Tray.exe):
  Empir3Tray.exe
    → spawns `Empir3Setup.exe --daemon-real` as child (same dir as the tray
      exe is the install dir; bootstrapper sits next to us). The bootstrapper
      then runs the unpacked daemon from the cached payload.
"""

import atexit
import json
import logging
import os
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path
from typing import Optional
from urllib import error as urlerror
from urllib import request as urlrequest

from PIL import Image, ImageDraw, ImageFont
import pystray

# Windows Job Object — assign every child daemon to this so a hard-kill of the
# tray (taskkill /F, OS shutdown) takes the daemon down with it. Without this
# the supervisor's children outlive the tray and squat on the bridge ports.
_JOB_HANDLE = None
_INSTANCE_MUTEX_HANDLE = None
if sys.platform == 'win32':
    try:
        import ctypes
        from ctypes import wintypes

        _kernel32 = ctypes.windll.kernel32
        _JOB_HANDLE = _kernel32.CreateJobObjectW(None, None)
        if _JOB_HANDLE:
            # JOBOBJECT_EXTENDED_LIMIT_INFORMATION (44 + 48 + 24 = 116 bytes on x64).
            # Easiest: use the structured layout from the SDK.
            class _IO_COUNTERS(ctypes.Structure):
                _fields_ = [
                    ('ReadOperationCount', ctypes.c_ulonglong),
                    ('WriteOperationCount', ctypes.c_ulonglong),
                    ('OtherOperationCount', ctypes.c_ulonglong),
                    ('ReadTransferCount', ctypes.c_ulonglong),
                    ('WriteTransferCount', ctypes.c_ulonglong),
                    ('OtherTransferCount', ctypes.c_ulonglong),
                ]

            class _JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
                _fields_ = [
                    ('PerProcessUserTimeLimit', wintypes.LARGE_INTEGER),
                    ('PerJobUserTimeLimit', wintypes.LARGE_INTEGER),
                    ('LimitFlags', wintypes.DWORD),
                    ('MinimumWorkingSetSize', ctypes.c_size_t),
                    ('MaximumWorkingSetSize', ctypes.c_size_t),
                    ('ActiveProcessLimit', wintypes.DWORD),
                    ('Affinity', ctypes.c_size_t),
                    ('PriorityClass', wintypes.DWORD),
                    ('SchedulingClass', wintypes.DWORD),
                ]

            class _JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
                _fields_ = [
                    ('BasicLimitInformation', _JOBOBJECT_BASIC_LIMIT_INFORMATION),
                    ('IoInfo', _IO_COUNTERS),
                    ('ProcessMemoryLimit', ctypes.c_size_t),
                    ('JobMemoryLimit', ctypes.c_size_t),
                    ('PeakProcessMemoryUsed', ctypes.c_size_t),
                    ('PeakJobMemoryUsed', ctypes.c_size_t),
                ]

            _info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
            _info.BasicLimitInformation.LimitFlags = 0x00002000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            _kernel32.SetInformationJobObject(
                _JOB_HANDLE,
                9,  # JobObjectExtendedLimitInformation
                ctypes.byref(_info),
                ctypes.sizeof(_info),
            )
    except Exception as _e:
        _JOB_HANDLE = None


def _attach_to_job(pid: int) -> bool:
    """Add a child PID to our Job Object so it dies with us on hard-kill."""
    if not _JOB_HANDLE or sys.platform != 'win32':
        return False
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        # OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, FALSE, pid)
        h = kernel32.OpenProcess(0x0100 | 0x0001, False, pid)
        if not h:
            return False
        ok = bool(kernel32.AssignProcessToJobObject(_JOB_HANDLE, h))
        kernel32.CloseHandle(h)
        return ok
    except Exception:
        return False

# ── Paths + config ─────────────────────────────────────────────────────

APPDATA = Path(os.environ.get('APPDATA') or Path.home() / '.empir3') / 'Empir3'
APPDATA.mkdir(parents=True, exist_ok=True)
TRAY_LOG = APPDATA / 'tray.log'
BRIDGE_LOG = APPDATA / 'bridge.log'
AUTH_FILE = APPDATA / 'bridge-auth.json'
SETTINGS_FILE = APPDATA / 'bridge-settings.json'
BOOTSTRAP_POINTER_FILE = APPDATA / 'bridge-bootstrap.json'
NONCE_FILE = Path.home() / '.empir3-bridge' / 'nonce'
# focus.json is written by the bridge daemon whenever an agent-focus region
# is active (via desktop_select_region); deleted on desktop_release_focus
# or TTL expiry. Tray reads it to decide whether to show "Release focus".
DESKTOP_FOCUS_FILE = Path.home() / '.empir3-bridge' / 'payload' / 'feedback' / 'desktop' / 'focus.json'
DESKTOP_POINTER_FILE = Path.home() / '.empir3-bridge' / 'payload' / 'feedback' / 'desktop' / 'pointer.json'

# Device-level permission categories. Mirrors bridge/permissions.js — keep
# the category names + defaults in sync. Writing flips the settings file
# directly; the daemon re-reads on every tool dispatch so changes take
# effect immediately, no daemon restart needed.
def _read_settings() -> dict:
    try:
        return json.loads(SETTINGS_FILE.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return {}


def _write_settings(state: dict) -> None:
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(state, indent=2), encoding='utf-8')


# ── Auto-update setting ────────────────────────────────────────────────
#
# Stored in bridge-settings.json alongside permissions. Default ON: the
# bridge auto-applies new payload versions in the background. Off: tray
# notifies but waits for explicit "Check for updates" click.

AUTO_UPDATE_DEFAULT = True

def get_auto_update() -> bool:
    saved = _read_settings()
    val = saved.get('autoUpdate')
    if val is None:
        return AUTO_UPDATE_DEFAULT
    return bool(val)


def set_auto_update(enabled: bool) -> None:
    saved = _read_settings()
    saved['autoUpdate'] = bool(enabled)
    _write_settings(saved)
    logger.info('auto-update set: %s', enabled)


# ── Handler-family toggles (generic schema) ────────────────────────────
#
# settings.handlers.<name>.enabled. The bridge daemon + the MCP shim both
# read this on every dispatch / startup respectively. Same pattern lets
# future handlers (Replicate, Runway, Suno) drop in with no schema
# migration — see TOOL_FAMILY in src/tool-defaults.ts.

def get_handler_enabled(name: str) -> bool:
    saved = _read_settings()
    return bool((saved.get('handlers') or {}).get(name, {}).get('enabled'))


def set_handler_enabled(name: str, enabled: bool) -> None:
    saved = _read_settings()
    handlers = dict(saved.get('handlers') or {})
    entry = dict(handlers.get(name) or {})
    entry['enabled'] = bool(enabled)
    handlers[name] = entry
    saved['handlers'] = handlers
    _write_settings(saved)
    logger.info('handler %s set: %s', name, enabled)


def _bootstrap_from_pointer() -> Optional[str]:
    try:
        data = json.loads(BOOTSTRAP_POINTER_FILE.read_text(encoding='utf-8'))
        candidate = str(data.get('bootstrapPath') or '').strip()
        if candidate and Path(candidate).exists():
            return candidate
    except (OSError, json.JSONDecodeError):
        pass
    return None


def _bootstrap_from_autostart() -> Optional[str]:
    if sys.platform != 'win32':
        return None
    try:
        result = subprocess.run(
            ['reg', 'query', r'HKCU\Software\Microsoft\Windows\CurrentVersion\Run', '/v', 'Empir3Bridge'],
            capture_output=True,
            text=True,
            creationflags=CREATE_NO_WINDOW,
            timeout=3,
        )
        if result.returncode != 0:
            return None
        for line in result.stdout.splitlines():
            if 'REG_SZ' not in line:
                continue
            raw = line.split('REG_SZ', 1)[1].strip()
            if raw.startswith('"'):
                candidate = raw.split('"', 2)[1]
            else:
                candidate = raw.split(' --', 1)[0].strip()
            if candidate and Path(candidate).exists():
                return candidate
    except Exception:
        return None
    return None


def resolve_bootstrap_exe() -> Optional[str]:
    """Locate Empir3Setup.exe regardless of where the tray itself runs from.

    The frozen tray lives inside payload/<version>/Empir3Tray.exe, but the
    bootstrapper exe usually sits in %APPDATA%/Empir3/ — NOT next to the tray.
    So the parent-dir sibling check is only a last resort. Resolution order
    mirrors DaemonSupervisor._spawn_args so the daemon-spawn and uninstall
    paths agree on the same bootstrapper:

      1. EMPIR3_BOOTSTRAP_EXE env (set by payload-entry.js when it spawns us)
      2. bridge-bootstrap.json pointer (written on every daemon launch)
      3. HKCU autostart "Empir3Bridge" value
      4. sibling next to a frozen Empir3Tray.exe (legacy / same-dir installs)

    Returns the absolute path as a string, or None when nothing is found
    (e.g. dev runs where the bridge is launched via `node index.js`).
    """
    from_env = os.environ.get('EMPIR3_BOOTSTRAP_EXE', '').strip()
    if from_env and Path(from_env).exists():
        return from_env

    from_pointer = _bootstrap_from_pointer()
    if from_pointer:
        return from_pointer

    from_autostart = _bootstrap_from_autostart()
    if from_autostart:
        return from_autostart

    if getattr(sys, 'frozen', False):
        sibling = Path(sys.executable).parent / 'Empir3Setup.exe'
        if sibling.exists():
            return str(sibling)

    return None


# ── Native dialogs ─────────────────────────────────────────────────────
#
# The tray runs --windowed (no console), so the only way to talk to the user
# synchronously is a real Win32 MessageBox. Used to gate the destructive
# uninstall behind an explicit Yes and to surface failures instead of
# silently doing nothing.

_MB_OK = 0x0
_MB_YESNO = 0x4
_MB_ICONERROR = 0x10
_MB_ICONWARNING = 0x30
_MB_DEFBUTTON2 = 0x100        # default the focus to the *second* button (No)
_MB_SETFOREGROUND = 0x10000
_MB_TOPMOST = 0x40000
_IDYES = 6


def _message_box(text: str, title: str, flags: int) -> int:
    """Show a modal Win32 MessageBox; return the clicked-button code.
    Returns 0 on non-Windows or on failure (caller decides what 0 means).
    Safe to call from any thread — MessageBoxW pumps its own loop."""
    if sys.platform != 'win32':
        return 0
    try:
        import ctypes
        return int(ctypes.windll.user32.MessageBoxW(None, text, title, flags))
    except Exception as e:
        logger.warning('message box failed: %s', e)
        return 0


def _confirm_uninstall() -> bool:
    """Yes/No gate shown before anything is deleted. Defaults to No. On a
    dialog failure we return False (abort) rather than wipe unacknowledged —
    the whole point of this prompt is that uninstall never happens silently."""
    res = _message_box(
        'Uninstall Empir3 Bridge?\n\n'
        'This stops the bridge, removes it from Windows startup, and deletes '
        'its sign-in, settings, cached data, and browser profile from this '
        'computer.\n\n'
        'This cannot be undone.',
        'Uninstall Empir3',
        _MB_YESNO | _MB_ICONWARNING | _MB_DEFBUTTON2 | _MB_SETFOREGROUND | _MB_TOPMOST,
    )
    return res == _IDYES


# ── Version helpers ────────────────────────────────────────────────────
#
# Two distinct versions matter to the user:
#   - DAEMON  — what's running right now (read from /api/relay-status)
#   - TRAY    — the .exe currently driving the menu (frozen → parent dir
#               name; dev → 'dev'). Only differs from daemon if the user
#               hasn't restarted the tray since the last payload update.

def get_running_tray_version() -> str:
    """Version stamp on disk next to THIS tray exe. 'dev' when unfrozen."""
    if not getattr(sys, 'frozen', False):
        return 'dev'
    try:
        # Frozen tray sits inside payload/<version>/Empir3Tray.exe — the
        # bundled .payload-version next to it is the version this binary
        # was built for.
        stamp = Path(sys.executable).parent / '.payload-version'
        if stamp.exists():
            return stamp.read_text(encoding='utf-8').strip()
        # PyInstaller --onefile extracts to a temp dir; the parent there
        # is %TEMP%/_MEIxxxxx, not the install dir. Fall back to the
        # active payload pointer.
        if PAYLOAD_VERSION_FILE.exists():
            return PAYLOAD_VERSION_FILE.read_text(encoding='utf-8').strip()
    except Exception:
        pass
    return 'unknown'


def get_active_payload_version() -> str:
    """The payload .version pointer — what bootstrap thinks is current."""
    active = 'unknown'
    try:
        if PAYLOAD_VERSION_FILE.exists():
            active = PAYLOAD_VERSION_FILE.read_text(encoding='utf-8').strip()
    except Exception:
        pass

    # If the user is already running a newer tray from payload/<version> but
    # the pointer is stale, repair it. Otherwise update checks can restart the
    # daemon into an older payload while the newer tray keeps the target dir
    # locked.
    tray_version = get_running_tray_version()
    try:
        if is_newer(tray_version, active) and (PAYLOAD_ROOT / tray_version / 'entry.js').exists():
            PAYLOAD_ROOT.mkdir(parents=True, exist_ok=True)
            PAYLOAD_VERSION_FILE.write_text(tray_version, encoding='utf-8')
            logger.info('repaired active payload pointer: %s -> %s', active, tray_version)
            return tray_version
    except Exception as e:
        logger.warning('active payload pointer repair failed: %s', e)

    return active


def fetch_remote_manifest(timeout=5) -> Optional[dict]:
    """GET the public manifest. Returns None on any failure (silent)."""
    try:
        req = urlrequest.Request(VERSION_MANIFEST_URL,
                                 headers={'User-Agent': 'empir3-tray/1.0'})
        with urlrequest.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        logger.warning('manifest probe failed: %s', e)
        return None


def _ver_tuple(s: str) -> tuple:
    """Crude semver tuple for compare. 'dev'/'unknown' sort lowest."""
    if not s or s in ('dev', 'unknown'):
        return (-1,)
    try:
        return tuple(int(p) for p in s.split('.') if p.isdigit())
    except Exception:
        return (-1,)


def is_newer(remote: str, local: str) -> bool:
    return _ver_tuple(remote) > _ver_tuple(local)

CANDIDATE_PORTS = [3006, 3106, 3206, 3306]
BRIDGE_CONTROL_PORTS = sorted(set(CANDIDATE_PORTS + [9867, 9222]))
STATUS_POLL_SEC = 4.0
# Daemon HTTP responses are usually <50ms but can stall for several seconds when
# the daemon's shared event loop is momentarily busy (CDP/overlay work against an
# open page, PS spawns, GC, WS reconnects). A slow-but-valid reply still proves the
# daemon is ALIVE, so the timeout must exceed the worst observed stall — otherwise
# every poll aborts as a TimeoutError and the tray falsely shows "Daemon not
# running" while the browser dashboard (which tolerates the slow reply) shows
# connected. Keep this well above the daemon's stall ceiling.
STATUS_HTTP_TIMEOUT_SEC = 10.0
# Require this many consecutive failed polls before we surface the daemon as
# disconnected. With STATUS_POLL_SEC=4s, FAILS=3 means ~12s of genuine misses
# before the menu flips — covers the longest real outage without flapping on a
# transient slow spell.
STATUS_DISCONNECT_AFTER_FAILS = 3
RESTART_BACKOFF_SEC = [3, 5, 10, 30, 60]  # capped at last value
SERVER_URL = os.environ.get('EMPIR3_SERVER', 'https://app.empir3.com')
VERSION_MANIFEST_URL = f'{SERVER_URL}/downloads/bridge-version.json'
UPDATE_CHECK_INTERVAL_SEC = 30 * 60  # poll the manifest every 30 min
UPDATE_CHECK_INITIAL_DELAY_SEC = 60   # don't probe immediately on tray start

# Where the bootstrapper writes the active payload version. Source of truth
# for both "what daemon binary is on disk" (via .version pointer) and "what
# tray binary is currently running" (parent dir of sys.executable when frozen).
PAYLOAD_ROOT = Path.home() / '.empir3-bridge' / 'payload'
PAYLOAD_VERSION_FILE = PAYLOAD_ROOT / '.version'

# Hide the console window when spawning child processes on Windows.
CREATE_NO_WINDOW = 0x08000000 if sys.platform == 'win32' else 0

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(name)s %(message)s',
    handlers=[
        logging.FileHandler(TRAY_LOG, encoding='utf-8'),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger('empir3.tray')


def _json_from_powershell(script: str, timeout: float = 5.0):
    if sys.platform != 'win32':
        return None
    try:
        proc = subprocess.run(
            ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            creationflags=CREATE_NO_WINDOW,
        )
        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout or '').strip()
            if err:
                logger.warning('powershell probe failed: %s', err[:500])
            return None
        text = (proc.stdout or '').strip()
        if not text:
            return None
        return json.loads(text)
    except Exception as e:
        logger.warning('powershell probe threw: %s', e)
        return None


def _as_list(value) -> list:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _process_infos_for_pids(pids: set[int]) -> list[dict]:
    if not pids or sys.platform != 'win32':
        return []
    pid_list = ','.join(str(int(pid)) for pid in sorted(pids) if int(pid) > 0)
    if not pid_list:
        return []
    script = (
        f'$pids=@({pid_list}); '
        'Get-CimInstance Win32_Process | '
        'Where-Object { $pids -contains $_.ProcessId } | '
        'Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | '
        'ConvertTo-Json -Compress'
    )
    return [p for p in _as_list(_json_from_powershell(script)) if isinstance(p, dict)]


def _bridge_port_owner_pids() -> set[int]:
    if sys.platform != 'win32':
        return set()
    ports = ','.join(str(p) for p in BRIDGE_CONTROL_PORTS)
    script = (
        f'$ports=@({ports}); '
        'Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | '
        'Where-Object { $ports -contains $_.LocalPort } | '
        'Select-Object -ExpandProperty OwningProcess -Unique | '
        'ConvertTo-Json -Compress'
    )
    data = _json_from_powershell(script)
    pids = set()
    for raw in _as_list(data):
        try:
            pid = int(raw)
            if pid > 0:
                pids.add(pid)
        except Exception:
            pass
    return pids


def _bridge_source_session_infos() -> list[dict]:
    """Find bridge dev/test sessions that may not yet own a port.

    This intentionally excludes MCP shims and the tray itself. It targets
    sessions agents commonly leave behind while testing the bridge daemon.
    """
    if sys.platform != 'win32':
        return []
    script = r'''
      $selfPid = $PID
      Get-CimInstance Win32_Process |
        Where-Object {
          $cmd = [string]$_.CommandLine
          $_.ProcessId -ne $selfPid -and
          $_.Name -notmatch '^(powershell|pwsh)\.exe$' -and
          (
            $cmd -match 'empir3-bridge[\\/](src[\\/](bridge|server)\.ts|build[\\/]payload-staging[\\/]bundle-(bridge|server|daemon)\.js)' -or
            $cmd -match '--user-data-dir=.*\.empir3-bridge[\\/]profile'
          )
        } |
        Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine |
        ConvertTo-Json -Compress
    '''
    return [p for p in _as_list(_json_from_powershell(script)) if isinstance(p, dict)]


def _normalized_process_text(info: dict) -> str:
    return ' '.join(str(info.get(k) or '') for k in ('Name', 'ExecutablePath', 'CommandLine')).lower().replace('/', '\\')


def _is_bridge_owned_process(info: dict, *, port_owner: bool) -> bool:
    pid = int(info.get('ProcessId') or 0)
    if pid <= 0 or pid == os.getpid():
        return False
    name = str(info.get('Name') or '').lower()
    if name == 'empir3tray.exe':
        return False
    text = _normalized_process_text(info)
    if '\\.empir3-bridge\\profile' in text:
        return True
    if 'empir3-bridge\\src\\bridge.ts' in text or 'empir3-bridge\\src\\server.ts' in text:
        return True
    if 'bundle-bridge.js' in text or 'bundle-server.js' in text or 'bundle-daemon.js' in text:
        return True
    if port_owner and 'empir3setup.exe' in text:
        return True
    if port_owner and '\\.empir3-bridge\\payload\\' in text and name in ('node.exe', 'empir3setup.exe'):
        return True
    return False


def _kill_process_tree(pid: int, reason: str) -> bool:
    if pid <= 0:
        return False
    try:
        if sys.platform == 'win32':
            proc = subprocess.run(
                ['taskkill', '/PID', str(pid), '/T', '/F'],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=8,
                creationflags=CREATE_NO_WINDOW,
            )
            if proc.returncode == 0:
                logger.info('cleanup: killed bridge-owned process tree pid=%s (%s)', pid, reason)
                return True
            logger.warning('cleanup: taskkill pid=%s failed: %s', pid, (proc.stderr or proc.stdout or '').strip()[:500])
            return False
        os.kill(pid, 9)
        logger.info('cleanup: killed bridge-owned process pid=%s (%s)', pid, reason)
        return True
    except Exception as e:
        logger.warning('cleanup: failed to kill pid=%s: %s', pid, e)
        return False


def cleanup_bridge_owned_processes(reason: str) -> int:
    """Release bridge ports without killing unrelated localhost services."""
    port_pids = _bridge_port_owner_pids()
    port_infos = _process_infos_for_pids(port_pids)
    candidates: dict[int, tuple[dict, bool]] = {}
    for info in port_infos:
        pid = int(info.get('ProcessId') or 0)
        candidates[pid] = (info, True)
    for info in _bridge_source_session_infos():
        pid = int(info.get('ProcessId') or 0)
        candidates.setdefault(pid, (info, False))

    killed = 0
    for pid, (info, port_owner) in sorted(candidates.items()):
        if _is_bridge_owned_process(info, port_owner=port_owner):
            if _kill_process_tree(pid, reason):
                killed += 1
        elif port_owner:
            logger.warning(
                'cleanup: leaving non-bridge process on bridge port alone pid=%s name=%s cmd=%s',
                pid,
                info.get('Name'),
                str(info.get('CommandLine') or '')[:240],
            )
    if killed:
        time.sleep(1)
    return killed


def _acquire_single_instance() -> bool:
    """Return False when another tray is already supervising the bridge."""
    global _INSTANCE_MUTEX_HANDLE
    if sys.platform != 'win32':
        return True
    try:
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.windll.kernel32
        kernel32.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
        kernel32.CreateMutexW.restype = wintypes.HANDLE
        handle = kernel32.CreateMutexW(None, True, 'Local\\Empir3BridgeTray')
        already_exists = kernel32.GetLastError() == 183  # ERROR_ALREADY_EXISTS
        if not handle:
            logger.warning('single-instance mutex could not be created; continuing')
            return True
        if already_exists:
            kernel32.CloseHandle(handle)
            logger.info('another Empir3Tray instance is already running; exiting this copy')
            return False
        _INSTANCE_MUTEX_HANDLE = handle

        def _release_mutex():
            try:
                kernel32.ReleaseMutex(_INSTANCE_MUTEX_HANDLE)
                kernel32.CloseHandle(_INSTANCE_MUTEX_HANDLE)
            except Exception:
                pass
        atexit.register(_release_mutex)
        return True
    except Exception as e:
        logger.warning('single-instance guard failed; continuing: %s', e)
        return True


# ── Icon rendering ─────────────────────────────────────────────────────

def _create_icon_image(connected: bool) -> Image.Image:
    """Solid circle with an 'E' in the middle. Green=connected, red=not."""
    size = 64
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    color = (46, 204, 113) if connected else (231, 76, 60)
    draw.ellipse([4, 4, size - 4, size - 4], fill=color)
    try:
        font = ImageFont.truetype('arial.ttf', 28)
    except (OSError, IOError):
        font = ImageFont.load_default()
    text = 'E'
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    draw.text(((size - tw) // 2, (size - th) // 2 - 2), text, fill='white', font=font)
    return img


# ── Bridge daemon supervisor ───────────────────────────────────────────

class DaemonSupervisor:
    """
    Owns the lifetime of the bridge child process. Restarts on crash.

    Spawn target depends on whether we're running PyInstaller-frozen or as a
    plain Python script — see _spawn_args().
    """

    def __init__(self, on_state_change=None):
        self._proc: Optional[subprocess.Popen] = None
        self._lock = threading.Lock()
        self._stop_requested = False
        self._restart_attempts = 0
        self._on_state_change = on_state_change or (lambda *_: None)
        self._supervise_thread: Optional[threading.Thread] = None
        self._clean_before_next_spawn = True
        self._spawn_count = 0

    def _spawn_args(self):
        """
        Choose what to spawn.

        Order of resolution:
          1. EMPIR3_BOOTSTRAP_EXE env var — set by payload-entry.js when it
             spawns the tray. Most reliable in production.
          2. Frozen (PyInstaller) sibling: Empir3Setup.exe next to us.
          3. Dev: `node <repo>/bridge/index.js`.

        For #1 + #2 we ask the bootstrapper for `--daemon-real` so it skips
        the tray-spawn branch and runs the actual bridge daemon.
        """
        bootstrap = resolve_bootstrap_exe()
        if bootstrap:
            return [bootstrap, '--daemon-real']

        if getattr(sys, 'frozen', False):
            install_dir = Path(sys.executable).parent
            raise FileNotFoundError(
                f'Empir3Setup.exe not found via EMPIR3_BOOTSTRAP_EXE, bridge-bootstrap.json, autostart, or beside Empir3Tray.exe at {install_dir} '
                '— reinstall the bridge to repair.'
            )

        # Dev: walk up from bridge/tray/ → bridge/ → repo root
        bridge_dir = Path(__file__).resolve().parent.parent
        index_js = bridge_dir / 'index.js'
        if not index_js.exists():
            raise FileNotFoundError(f'bridge/index.js not found at {index_js}')
        node = os.environ.get('NODE_BIN', 'node')
        return [node, str(index_js)]

    def start(self):
        """Spawn the daemon and start the supervise loop in a background thread."""
        if self._supervise_thread and self._supervise_thread.is_alive():
            return
        self._stop_requested = False
        self._supervise_thread = threading.Thread(target=self._supervise_loop, daemon=True)
        self._supervise_thread.start()

    def mark_clean_before_next_spawn(self):
        with self._lock:
            self._clean_before_next_spawn = True
            self._restart_attempts = 0

    def restart(self, clean_ports: bool = True):
        """Kill the current child; supervise loop will respawn."""
        with self._lock:
            self._restart_attempts = 0
            if clean_ports:
                self._clean_before_next_spawn = True
            if self._proc and self._proc.poll() is None:
                logger.info('restart: terminating current daemon pid=%s', self._proc.pid)
                try:
                    self._proc.terminate()
                except Exception as e:
                    logger.warning('terminate failed: %s', e)

    def stop(self, clean_ports: bool = True):
        """Kill the child and stop the supervise loop. Call once on Quit."""
        self._stop_requested = True
        with self._lock:
            if self._proc and self._proc.poll() is None:
                logger.info('stop: terminating daemon pid=%s', self._proc.pid)
                try:
                    self._proc.terminate()
                    self._proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    logger.warning('daemon did not exit in 5s, killing')
                    try:
                        self._proc.kill()
                    except Exception:
                        pass
                except Exception as e:
                    logger.warning('terminate failed: %s', e)
        if clean_ports:
            killed = cleanup_bridge_owned_processes('tray stop')
            if killed:
                logger.info('stop: cleaned %s bridge-owned stale process tree(s)', killed)

    def _supervise_loop(self):
        while not self._stop_requested:
            do_cleanup = False
            with self._lock:
                if self._clean_before_next_spawn or self._spawn_count == 0:
                    do_cleanup = True
                    self._clean_before_next_spawn = False
            if do_cleanup:
                killed = cleanup_bridge_owned_processes('before daemon spawn')
                if killed:
                    logger.info('pre-spawn cleanup: removed %s bridge-owned stale process tree(s)', killed)

            try:
                args = self._spawn_args()
            except FileNotFoundError as e:
                logger.error('cannot spawn daemon: %s', e)
                self._on_state_change('error', str(e))
                time.sleep(10)
                continue

            logger.info('spawning daemon: %s', ' '.join(args))
            self._on_state_change('starting', None)
            log_handle = None
            try:
                BRIDGE_LOG.parent.mkdir(parents=True, exist_ok=True)
                log_handle = open(BRIDGE_LOG, 'ab', buffering=0)
                stamp = time.strftime('%Y-%m-%d %H:%M:%S')
                log_handle.write(f'\n--- daemon spawn {stamp}: {" ".join(args)} ---\n'.encode('utf-8', errors='replace'))
                with self._lock:
                    self._proc = subprocess.Popen(
                        args,
                        stdout=log_handle,
                        stderr=subprocess.STDOUT,
                        stdin=subprocess.DEVNULL,
                        creationflags=CREATE_NO_WINDOW,
                        cwd=str(Path(args[0]).parent) if Path(args[0]).is_absolute() else None,
                    )
            except Exception as e:
                try:
                    if log_handle:
                        log_handle.close()
                except Exception:
                    pass
                logger.error('spawn failed: %s', e)
                self._on_state_change('error', str(e))
                self._sleep_backoff()
                continue

            logger.info('daemon spawned pid=%s', self._proc.pid)
            self._spawn_count += 1
            if _attach_to_job(self._proc.pid):
                logger.info('daemon attached to tray job object (will die with tray)')
            self._on_state_change('running', None)
            exit_code = self._proc.wait()
            try:
                if log_handle:
                    log_handle.close()
            except Exception:
                pass
            logger.warning('daemon exited code=%s', exit_code)
            self._on_state_change('exited', f'code={exit_code}')

            if self._stop_requested:
                break
            if exit_code == 0:
                # The daemon exits 0 for intentional self-restarts after
                # account sign-in/sign-out, pairing, and graceful reconnect.
                # Treat that as a fast handoff, not a crash, or account
                # switching snowballs into minute-long waits.
                self._restart_attempts = 0
                logger.info('daemon exited cleanly; restarting in 1s')
                time.sleep(1)
                continue
            self._sleep_backoff()
            self._restart_attempts += 1

    def _sleep_backoff(self):
        idx = min(self._restart_attempts, len(RESTART_BACKOFF_SEC) - 1)
        delay = RESTART_BACKOFF_SEC[idx]
        logger.info('restart backoff: sleeping %ss (attempt %s)', delay, self._restart_attempts + 1)
        for _ in range(delay):
            if self._stop_requested:
                return
            time.sleep(1)

    @property
    def child_pid(self) -> Optional[int]:
        with self._lock:
            return self._proc.pid if (self._proc and self._proc.poll() is None) else None


# ── Status poller ──────────────────────────────────────────────────────

class StatusPoller:
    """
    Polls the bridge's local /api/relay-status endpoint to discover its port
    and read connection state. Calls on_status(state) on every poll, where
    state is a dict like:
        { 'reachable': bool, 'port': int|None, 'connected': bool,
          'user_email': str|None, 'device_name': str|None,
          'channel_id': str|None, 'uptime_ms': int|None }
    """

    def __init__(self, on_status, on_tray_commands=None):
        self._on_status = on_status
        self._on_tray_commands = on_tray_commands or (lambda _cmds: None)
        self._stop = False
        self._thread: Optional[threading.Thread] = None
        self._last_port: Optional[int] = None  # remember which port worked last
        # Sticky-reachability bookkeeping. _consecutive_fails counts how many
        # back-to-back polls timed out; we only emit a "disconnected" state to
        # the menu after STATUS_DISCONNECT_AFTER_FAILS of those. _last_ok keeps
        # the most recent successful poll so we can replay it if we want to
        # avoid menu flap during a transient blip.
        self._consecutive_fails = 0
        self._last_ok: Optional[dict] = None

    def start(self):
        self._stop = False
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop = True

    def _loop(self):
        while not self._stop:
            state = self._poll_once()
            try:
                self._on_status(state)
            except Exception as e:
                logger.warning('on_status callback raised: %s', e)
            if state.get('reachable') and state.get('port'):
                commands = self._drain_tray_commands(state['port'])
                if commands:
                    try:
                        self._on_tray_commands(commands)
                    except Exception as e:
                        logger.warning('on_tray_commands callback raised: %s', e)
            time.sleep(STATUS_POLL_SEC)

    def _drain_tray_commands(self, port: int) -> list:
        """Fetch + clear the bridge daemon's tray-command queue. The welcome
        page enqueues lifecycle commands (restart tray, quit, uninstall, check
        updates) and the daemon hands them off to us on this poll. Short
        timeout because the daemon clears the queue server-side regardless."""
        try:
            req = urlrequest.Request(f'http://127.0.0.1:{port}/api/tray/commands')
            with urlrequest.urlopen(req, timeout=STATUS_HTTP_TIMEOUT_SEC) as resp:
                body = json.loads(resp.read().decode('utf-8'))
            if not body.get('ok'):
                return []
            return body.get('commands') or []
        except Exception as e:
            logger.debug('tray command drain failed on port %s: %s', port, e)
            return []

    def _poll_once(self) -> dict:
        # Try last-known-good port first, then fall back to scanning.
        ports = []
        if self._last_port:
            ports.append(self._last_port)
        for p in CANDIDATE_PORTS:
            if p not in ports:
                ports.append(p)

        for port in ports:
            try:
                req = urlrequest.Request(f'http://127.0.0.1:{port}/api/relay-status')
                with urlrequest.urlopen(req, timeout=STATUS_HTTP_TIMEOUT_SEC) as resp:
                    body = json.loads(resp.read().decode('utf-8'))
                if not body.get('ok'):
                    continue
                relay = body.get('relay') or {}
                # /api/relay-status returns the connected user inside relay.user
                # when the relay is up. When in splash mode (no auth), it returns
                # a top-level authUser=null + mode='splash' so the tray can render
                # the right "Sign in" affordance instead of a misleading
                # "Disconnected" status.
                relay_user = relay.get('user') or {}
                auth_user = body.get('authUser') or {}
                email = relay_user.get('email') or auth_user.get('email')
                self._last_port = port
                self._consecutive_fails = 0
                ok_state = {
                    'reachable': True,
                    'port': port,
                    'connected': bool(relay.get('connected')),
                    'user_email': email,
                    'device_name': relay.get('deviceName'),
                    'channel_id': relay.get('channelId'),
                    'uptime_ms': body.get('uptimeMs'),
                    'mode': body.get('mode') or 'paired',
                    'has_auth': bool(body.get('hasAuth')),
                    'standalone': bool(body.get('standalone')),
                    'daemon_version': body.get('version'),
                    'server_url': body.get('serverUrl'),
                    'auth_rejected': bool(relay.get('authRejected')),
                    'relay_close_code': relay.get('lastCloseCode'),
                    'relay_close_reason': relay.get('lastCloseReason'),
                }
                self._last_ok = ok_state
                return ok_state
            except (urlerror.URLError, ConnectionError, OSError, TimeoutError, json.JSONDecodeError):
                continue
            except Exception as e:
                logger.warning('poll error on port %s: %s', port, e)
                continue

        # Nothing answered this round. If we've succeeded recently and the
        # failure streak is still short, keep showing the cached good state
        # — almost certainly a brief daemon stall, not a real outage. Only
        # surface "disconnected" after STATUS_DISCONNECT_AFTER_FAILS misses.
        self._consecutive_fails += 1
        if self._last_ok is not None and self._consecutive_fails < STATUS_DISCONNECT_AFTER_FAILS:
            return self._last_ok
        self._last_port = None
        self._last_ok = None
        return {
            'reachable': False, 'port': None, 'connected': False,
            'user_email': None, 'device_name': None,
            'channel_id': None, 'uptime_ms': None,
            'mode': None, 'has_auth': False, 'standalone': False,
            'daemon_version': None, 'server_url': None,
            'auth_rejected': False, 'relay_close_code': None, 'relay_close_reason': None,
        }


# ── Update checker ─────────────────────────────────────────────────────
#
# Polls the public manifest on a 30-min cadence. When a newer version is
# available:
#   - autoUpdate ON  → restart the daemon (bootstrap fetches + extracts)
#   - autoUpdate OFF → notify the user; "Check for updates" handles install
#
# Keeps state in memory only (last-known remote version) so the user's
# explicit "Check for updates" click can short-circuit the next probe.

class UpdateChecker:
    def __init__(self, on_apply, on_notify):
        self._on_apply = on_apply
        self._on_notify = on_notify
        self._stop = False
        self._thread: Optional[threading.Thread] = None
        self._last_remote_version: Optional[str] = None
        self._last_check_at: float = 0.0

    def start(self):
        self._stop = False
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop = True

    def check_now(self) -> tuple:
        """
        Force a check + act on the result. Returns (state, local, remote)
        where state is one of: 'up_to_date', 'newer_available', 'applied',
        'probe_failed'. Used by the menu's "Check for updates" item to
        give immediate feedback.
        """
        manifest = fetch_remote_manifest(timeout=5)
        self._last_check_at = time.time()
        if not manifest:
            return ('probe_failed', None, None)
        remote = manifest.get('version')
        local = get_active_payload_version()
        self._last_remote_version = remote
        if not remote or not is_newer(remote, local):
            return ('up_to_date', local, remote)
        # Newer available — apply unconditionally on manual click.
        try:
            self._on_apply(remote)
            return ('applied', local, remote)
        except Exception as e:
            logger.error('update apply failed: %s', e)
            return ('newer_available', local, remote)

    def _loop(self):
        # Initial delay so we don't compete with first-boot startup.
        for _ in range(UPDATE_CHECK_INITIAL_DELAY_SEC):
            if self._stop:
                return
            time.sleep(1)

        while not self._stop:
            try:
                manifest = fetch_remote_manifest(timeout=5)
                if manifest:
                    remote = manifest.get('version')
                    local = get_active_payload_version()
                    if remote and is_newer(remote, local):
                        if remote != self._last_remote_version:
                            logger.info('update available: %s → %s', local, remote)
                        self._last_remote_version = remote
                        if get_auto_update():
                            try:
                                self._on_apply(remote)
                            except Exception as e:
                                logger.error('auto-update apply failed: %s', e)
                        else:
                            try:
                                self._on_notify(local, remote)
                            except Exception:
                                pass
            except Exception as e:
                logger.warning('update loop error: %s', e)

            for _ in range(UPDATE_CHECK_INTERVAL_SEC):
                if self._stop:
                    return
                time.sleep(1)


# ── Tray UI ────────────────────────────────────────────────────────────

class EmpirTray:
    def __init__(self):
        self._icon: Optional[pystray.Icon] = None
        self._connected = False
        self._last_status: dict = {
            'reachable': False, 'port': None, 'connected': False,
            'user_email': None, 'device_name': None,
            'mode': None, 'has_auth': False, 'standalone': False,
            'daemon_version': None, 'server_url': None,
            'auth_rejected': False, 'relay_close_code': None, 'relay_close_reason': None,
        }
        self._tray_version = get_running_tray_version()
        self._supervisor = DaemonSupervisor(on_state_change=self._on_supervisor_state)
        self._clean_ports_on_final_stop = True
        self._poller = StatusPoller(
            on_status=self._on_status,
            on_tray_commands=self._on_tray_commands,
        )
        self._updater = UpdateChecker(
            on_apply=self._apply_update,
            on_notify=self._notify_update_available,
        )

    # ── State callbacks ──

    def _on_supervisor_state(self, state: str, detail: Optional[str]):
        logger.info('supervisor: %s%s', state, f' ({detail})' if detail else '')

    def _on_status(self, state: dict):
        prev = self._last_status
        self._last_status = state
        connected = state.get('connected', False)
        connected_changed = connected != self._connected
        if connected_changed:
            self._connected = connected
            logger.info(
                'status: connected=%s port=%s user=%s device=%s',
                connected, state.get('port'),
                state.get('user_email'), state.get('device_name'),
            )
        elif state.get('reachable') != prev.get('reachable'):
            logger.info('status: reachable=%s port=%s', state.get('reachable'), state.get('port'))
        # Refresh the menu whenever any user-visible state changes — mode
        # transitions (paired↔splash), version updates, and standalone
        # toggles all influence menu item visibility + labels.
        watched = ('reachable', 'connected', 'mode', 'has_auth', 'standalone',
                   'daemon_version', 'user_email', 'server_url', 'auth_rejected',
                   'relay_close_code', 'relay_close_reason')
        if any(state.get(k) != prev.get(k) for k in watched):
            self._refresh_icon()

    def _refresh_icon(self):
        if not self._icon:
            return
        try:
            daemon_online = bool(self._last_status.get('reachable'))
            self._icon.icon = _create_icon_image(daemon_online)
            label = self._device_label()
            self._icon.title = (
                f'Empir3 — {label} (Running)' if daemon_online
                else f'Empir3 — {label} (Disconnected)'
            )
            self._icon.update_menu()
        except Exception as e:
            logger.warning('icon refresh failed: %s', e)

    def _device_label(self) -> str:
        name = self._last_status.get('device_name')
        if name:
            return name
        try:
            import socket
            return socket.gethostname()
        except Exception:
            return 'Desktop'

    # ── Tray command queue (driven by the welcome-page command center) ──

    def _on_tray_commands(self, commands: list) -> None:
        """Dispatch lifecycle commands enqueued by the welcome page. The bridge
        daemon clears the queue when we drain it, so each command here is
        delivered exactly once. We log every one so a regression where the
        welcome page mis-sends a command is debuggable from tray.log alone."""
        for cmd in commands:
            try:
                kind = (cmd or {}).get('type', '')
                cid = (cmd or {}).get('id', '<no-id>')
                logger.info('tray command received: %s (id=%s)', kind, cid)
                if kind == 'tray_check_updates':
                    self._check_for_updates()
                elif kind == 'tray_apply_update':
                    # Same path as the periodic updater: restart the daemon so
                    # bootstrap fetches the payload, then restart the tray once
                    # the new tray binary exists.
                    params = (cmd or {}).get('params') or {}
                    self._apply_update(str(params.get('version') or 'latest'))
                elif kind == 'tray_toggle_auto_update':
                    self._toggle_auto_update(self._icon)
                elif kind == 'tray_open_log':
                    self._open_log()
                elif kind == 'tray_restart_tray':
                    if self._icon:
                        self._restart_tray(self._icon)
                elif kind == 'tray_quit':
                    if self._icon:
                        self._quit(self._icon)
                elif kind == 'tray_uninstall':
                    if self._icon:
                        self._uninstall(self._icon)
                else:
                    logger.warning('tray command: unknown type %r', kind)
            except Exception as e:
                logger.warning('tray command dispatch failed: %s', e)

    # ── Menu actions ──

    def _open_bridge(self, _icon=None, _item=None):
        # Surface Vincent's browser window — the exact CDP target Vincent
        # drives — so the user lands on what Vincent is about to navigate,
        # not a separate tab in their default browser. POSTs
        # desktop:browse:show to the local daemon, which calls
        # Page.bringToFront on the attached page (raises tab + window in
        # one shot). Falls back to opening app.empir3.com in the default
        # browser if the daemon isn't reachable, so the menu item is never
        # a dead end.
        def _do():
            port = self._last_status.get('port')
            if not port:
                self._notify('Bridge daemon not running — try Reconnect daemon first.')
                try: webbrowser.open(self._last_status.get('server_url') or SERVER_URL)
                except Exception: pass
                return
            nonce = None
            try:
                nonce = NONCE_FILE.read_text(encoding='utf-8').strip()
            except Exception as e:
                logger.warning('open-bridge: nonce read failed: %s', e)
            if not nonce:
                try: webbrowser.open(self._last_status.get('server_url') or SERVER_URL)
                except Exception: pass
                return
            try:
                req = urlrequest.Request(
                    f'http://127.0.0.1:{port}/api/command',
                    method='POST',
                    data=json.dumps({'action': 'desktop:browse:show', 'params': {}}).encode('utf-8'),
                    headers={
                        'Content-Type': 'application/json',
                        'X-Empir3-Nonce': nonce,
                    },
                )
                with urlrequest.urlopen(req, timeout=15.0) as resp:
                    if resp.status != 200:
                        raise RuntimeError(f'http {resp.status}')
                logger.info('open-bridge: surfaced Vincent\'s browser')
            except Exception as e:
                logger.warning('open-bridge: command failed (%s); falling back to default browser', e)
                try: webbrowser.open(self._last_status.get('server_url') or SERVER_URL)
                except Exception: pass
        threading.Thread(target=_do, daemon=True).start()

    def _has_focus(self) -> bool:
        # Bridge writes/deletes focus.json as the authoritative signal; cheap
        # stat call instead of HTTP polling on every menu open.
        try: return DESKTOP_FOCUS_FILE.exists()
        except Exception: return False

    def _has_pointer(self) -> bool:
        try: return DESKTOP_POINTER_FILE.exists()
        except Exception: return False

    def _post_command(self, type_: str, payload: dict | None = None, timeout: float = 5.0):
        port = self._last_status.get('port')
        if not port:
            self._notify('Bridge daemon not running — try Reconnect daemon first.')
            return None
        nonce = None
        try:
            nonce = NONCE_FILE.read_text(encoding='utf-8').strip()
        except Exception as e:
            logger.warning('post-command: nonce read failed: %s', e)
        try:
            body = {'type': type_}
            if payload: body.update(payload)
            req = urlrequest.Request(
                f'http://127.0.0.1:{port}/api/command',
                method='POST',
                data=json.dumps(body).encode('utf-8'),
                headers={
                    'Content-Type': 'application/json',
                    **({'X-Empir3-Nonce': nonce} if nonce else {}),
                },
            )
            with urlrequest.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode('utf-8'))
        except Exception as e:
            logger.warning('post-command %s failed: %s', type_, e)
            return None

    def _select_region_for_agent(self, _icon=None, _item=None):
        # Fires the bridge's region-selector overlay. Long timeout because the
        # user may take a while to choose; daemon resolves when they finish.
        def _do():
            res = self._post_command('desktop_select_region', {'timeoutMs': 120000}, timeout=130.0)
            if res and res.get('ok') and res.get('result', {}).get('region'):
                r = res['result']['region']
                self._notify(f"Agent focus set: {r['width']}x{r['height']} at ({r['x']},{r['y']})")
            elif res and res.get('result', {}).get('cancelled'):
                pass  # User cancelled, silent
            else:
                self._notify('Region selection failed — check bridge log.')
        threading.Thread(target=_do, daemon=True).start()

    def _release_agent_focus(self, _icon=None, _item=None):
        def _do():
            res = self._post_command('desktop_release_focus')
            if res and res.get('ok'):
                self._focus_grid_state = False
                try: self._icon.update_menu()
                except Exception: pass
                self._notify('Agent focus and screen artifacts released.')
        threading.Thread(target=_do, daemon=True).start()

    def _open_desktop_toolbar(self, _icon=None, _item=None):
        def _do():
            res = self._post_command('desktop_toolbar', {'action': 'show'}, timeout=5.0)
            if res and res.get('ok'):
                self._notify('Desktop toolbar opened.')
            else:
                self._notify('Desktop toolbar failed to open - check bridge log.')
        threading.Thread(target=_do, daemon=True).start()

    def _hide_agent_pointer(self, _icon=None, _item=None):
        def _do():
            res = self._post_command('desktop_pointer_hide')
            if res and res.get('ok'):
                self._notify('Agent pointer hidden.')
        threading.Thread(target=_do, daemon=True).start()

    def _focus_grid_running(self) -> bool:
        # Reflect a local boolean cached after each toggle. We don't poll the
        # bridge for this — the tray just remembers what it last asked for.
        return bool(getattr(self, '_focus_grid_state', False))

    def _toggle_focus_grid(self, _icon=None, _item=None):
        def _do():
            cur = bool(getattr(self, '_focus_grid_state', False))
            want = not cur
            res = self._post_command('desktop_focus_grid', {'action': 'show' if want else 'hide'}, timeout=3.0)
            if res and res.get('ok'):
                self._focus_grid_state = bool(res.get('result', {}).get('enabled', want))
                try: self._icon.update_menu()
                except Exception: pass
            else:
                self._notify('Focus grid toggle failed — check bridge log.')
        threading.Thread(target=_do, daemon=True).start()

    def _calibrate_pointer(self, _icon=None, _item=None):
        # Run an interactive click-calibration: bridge spawns a fullscreen
        # capture overlay + ghost pointer at primary-screen center; user
        # clicks where they see the cursor; bridge persists the delta. The
        # bridge call blocks for up to 60s, so do everything in a worker.
        def _do():
            self._notify('Click the green ghost cursor at the center of your screen.')
            res = self._post_command('desktop_calibrate_pointer', timeout=70.0)
            if not res or not res.get('ok'):
                if res and res.get('result', {}).get('cancelled'):
                    self._notify('Calibration cancelled.')
                else:
                    self._notify('Calibration failed — check bridge log.')
                return
            cal = (res.get('result') or {}).get('calibration') or {}
            dx = int(cal.get('offsetX', 0))
            dy = int(cal.get('offsetY', 0))
            persisted = (res.get('result') or {}).get('persisted')
            sign_x = '+' if dx >= 0 else ''
            sign_y = '+' if dy >= 0 else ''
            note = 'saved' if persisted else 'NOT saved (see log)'
            self._notify(f'Calibration {note}: offset ({sign_x}{dx}, {sign_y}{dy}) px.')
        threading.Thread(target=_do, daemon=True).start()

    def _open_log(self, _icon=None, _item=None):
        if not BRIDGE_LOG.exists():
            BRIDGE_LOG.parent.mkdir(parents=True, exist_ok=True)
            BRIDGE_LOG.touch()
        if sys.platform == 'win32':
            os.startfile(str(BRIDGE_LOG))  # noqa: SIM115 — Windows-only API
        elif sys.platform == 'darwin':
            subprocess.Popen(['open', str(BRIDGE_LOG)])
        else:
            subprocess.Popen(['xdg-open', str(BRIDGE_LOG)])

    def _reconnect(self, _icon=None, _item=None):
        # Two-step restart: HTTP graceful shutdown first so handlers drain
        # cleanly, then supervisor.restart() as fallback when the HTTP path
        # didn't take (daemon non-responsive, port not bound yet, etc.).
        # Reset _restart_attempts so backoff starts at 3s, not 60s.
        def _do():
            self._notify('Reconnecting daemon…')
            port = self._last_status.get('port')
            graceful = False
            self._supervisor.mark_clean_before_next_spawn()
            if port:
                try:
                    req = urlrequest.Request(
                        f'http://127.0.0.1:{port}/api/shutdown',
                        method='POST',
                        data=b'{}',
                        headers={'Content-Type': 'application/json'},
                    )
                    with urlrequest.urlopen(req, timeout=2.0) as resp:
                        if resp.status == 200:
                            graceful = True
                            logger.info('reconnect: graceful shutdown OK on port %s', port)
                except Exception as e:
                    logger.info('reconnect: graceful shutdown failed (%s); falling back to terminate', e)
            if not graceful:
                self._supervisor.restart(clean_ports=True)
            # Either way, supervise loop will see the exit + respawn.
            # Force-reset attempts so the user-triggered reconnect doesn't
            # inherit a long backoff from prior crashes.
            with self._supervisor._lock:
                self._supervisor._restart_attempts = 0
        threading.Thread(target=_do, daemon=True).start()

    def _welcome_url(self, port) -> str:
        # The polished welcome/account flow is served by the wrapper daemon on
        # `port`. `/api/status.bridgeUrl` points at the CDP bridge (:9867),
        # whose legacy setup page is still useful internally but is the wrong
        # place to send tray sign-in/open-welcome actions.
        return f'http://127.0.0.1:{port}/welcome'

    def _open_welcome(self, _icon=None, _item=None):
        port = self._last_status.get('port')
        if not port:
            self._notify('Bridge daemon not running - try Reconnect daemon first.')
            return
        self._open_controlled_url(port, f'http://127.0.0.1:{port}/welcome', 'welcome')

    def _sign_out(self, _icon=None, _item=None):
        # Delete the auth file and restart the daemon. On restart, the
        # daemon will detect missing auth and boot into splash mode (which
        # auto-launches the bridge Chrome at /welcome). User can then click
        # "Login with Empir3" to re-pair.
        #
        # Crucially, do NOT spawn `Empir3Setup.exe` again here — that would
        # start a SECOND tray + daemon (the no-args path goes through
        # spawnTrayAndExit). The single supervised daemon respawn handles
        # everything.
        def _do():
            try:
                if AUTH_FILE.exists():
                    AUTH_FILE.unlink()
                    logger.info('signed out: removed %s', AUTH_FILE)
            except Exception as e:
                logger.error('sign-out: failed to remove auth file: %s', e)
            # Trigger a reconnect through the same graceful-then-terminate
            # path as the manual Reconnect menu item.
            self._reconnect()
            self._notify('Signed out — opening sign-in page…')
            # Wait for the daemon to come back up without Empir3 auth, then
            # surface the welcome page in the controlled bridge browser.
            for _ in range(20):  # up to 10s
                time.sleep(0.5)
                port = self._last_status.get('port')
                has_auth = self._last_status.get('has_auth')
                if port and not has_auth:
                    self._open_controlled_url(port, self._welcome_url(port), 'sign-out')
                    return
            logger.warning('sign-out: daemon did not return without auth within 10s')
        threading.Thread(target=_do, daemon=True).start()

    def _sign_in(self, _icon=None, _item=None):
        # Open the bridge's welcome page in the controlled bridge Chrome
        # profile, not the user's default browser.
        port = self._last_status.get('port')
        if not port:
            self._notify('Bridge daemon not running — try Reconnect daemon first.')
            return
        try:
            self._open_controlled_url(port, self._welcome_url(port), 'sign-in')
        except Exception as e:
            logger.warning('sign-in: controlled browser open failed: %s', e)

    def _open_controlled_url(self, port: int, url: str, reason: str) -> bool:
        """Navigate and raise the controlled bridge browser to a specific URL."""
        nonce = ''
        try:
            nonce = NONCE_FILE.read_text(encoding='utf-8').strip()
        except Exception as e:
            logger.warning('%s: nonce read failed: %s', reason, e)
        headers = {'Content-Type': 'application/json'}
        if nonce:
            headers['X-Empir3-Nonce'] = nonce
        try:
            for payload in (
                {'action': 'navigate', 'url': url},
                {'action': 'desktop:browse:show', 'params': {}},
            ):
                req = urlrequest.Request(
                    f'http://127.0.0.1:{port}/api/command',
                    method='POST',
                    data=json.dumps(payload).encode('utf-8'),
                    headers=headers,
                )
                with urlrequest.urlopen(req, timeout=15.0) as resp:
                    if resp.status != 200:
                        raise RuntimeError(f'http {resp.status}')
            logger.info('%s: opened controlled bridge browser at %s', reason, url)
            return True
        except Exception as e:
            logger.warning('%s: controlled browser open failed: %s', reason, e)
            self._notify('Could not open the bridge browser - try Reconnect daemon.')
            return False

    def _check_for_updates(self, _icon=None, _item=None):
        def _do():
            self._notify('Checking for updates…')
            state, local, remote = self._updater.check_now()
            if state == 'up_to_date':
                self._notify(f'You\'re on the latest version (v{local}).')
            elif state == 'applied':
                self._notify(f'Updating to v{remote} (was v{local})…')
            elif state == 'newer_available':
                self._notify(f'Update v{remote} available — apply failed, see log.')
            else:
                self._notify('Couldn\'t reach the update server — check your connection.')
            try:
                self._icon.update_menu()
            except Exception:
                pass
        threading.Thread(target=_do, daemon=True).start()

    def _toggle_auto_update(self, _icon, _item=None):
        cur = get_auto_update()
        set_auto_update(not cur)
        try:
            self._icon.update_menu()
        except Exception:
            pass

    def _toggle_higgsfield(self, _icon=None, _item=None):
        # Coarse tray-level gate for the higgsfield_* MCP tool family. The
        # bridge daemon reads settings.handlers.higgsfield.enabled on every
        # dispatch, so a flip takes effect immediately. The MCP shim only
        # advertises higgsfield_* when this is true at MCP startup, which
        # means clients connected before the toggle should be reconnected
        # to see the new tools — surface that nuance in the notification.
        cur = get_handler_enabled('higgsfield')
        target = not cur
        set_handler_enabled('higgsfield', target)
        try:
            self._icon.update_menu()
        except Exception:
            pass
        if target:
            self._notify('Higgsfield CLI handler enabled. Restart your MCP client to see higgsfield_* tools.')
        else:
            self._notify('Higgsfield CLI handler disabled.')

    def _apply_update(self, new_version: str):
        """Restart the daemon — bootstrap will fetch + extract the new payload."""
        logger.info('apply_update: restarting daemon to pull v%s', new_version)
        # Use the same graceful-restart path as manual Reconnect.
        threading.Thread(target=self._reconnect, daemon=True).start()
        threading.Thread(target=self._restart_tray_when_update_ready, args=(new_version,), daemon=True).start()

    def _restart_tray_when_update_ready(self, new_version: str):
        deadline = time.time() + 90
        while time.time() < deadline:
            try:
                active = get_active_payload_version()
                new_tray = PAYLOAD_ROOT / active / 'Empir3Tray.exe'
                if is_newer(active, self._tray_version) and new_tray.exists():
                    logger.info('apply_update: tray payload ready (%s), restarting tray', active)
                    if self._icon:
                        self._restart_tray(self._icon)
                    return
            except Exception as e:
                logger.warning('apply_update: tray readiness probe failed: %s', e)
            time.sleep(2)
        logger.warning('apply_update: timed out waiting for tray payload v%s', new_version)

    def _notify_update_available(self, local: str, remote: str):
        self._notify(f'Update v{remote} available — open menu to install (currently v{local}).')

    def _restart_tray(self, icon, _item=None):
        # Used after a payload update bumps the tray binary on disk. We
        # spawn the new tray exe (in the just-extracted payload dir) then
        # exit ourselves. Job Object kill-on-close will tear down our
        # daemon child too — the new tray respawns it on its own.
        def _do():
            new_tray = PAYLOAD_ROOT / get_active_payload_version() / 'Empir3Tray.exe'
            if not new_tray.exists():
                logger.warning('restart_tray: new tray exe not found at %s', new_tray)
                self._notify('No newer tray to restart into.')
                return
            logger.info('restart_tray: stopping daemon before spawning new tray %s', new_tray)
            self._poller.stop()
            self._supervisor.stop(clean_ports=True)
            self._clean_ports_on_final_stop = False
            logger.info('restart_tray: spawning new tray %s', new_tray)
            try:
                tray_env = {**os.environ}
                bootstrap = os.environ.get('EMPIR3_BOOTSTRAP_EXE', '').strip() or _bootstrap_from_pointer() or _bootstrap_from_autostart()
                if bootstrap:
                    tray_env['EMPIR3_BOOTSTRAP_EXE'] = bootstrap
                subprocess.Popen(
                    [str(new_tray)],
                    cwd=str(new_tray.parent),
                    creationflags=CREATE_NO_WINDOW,
                    env=tray_env,
                )
            except Exception as e:
                logger.error('restart_tray: spawn failed: %s', e)
                self._notify(f'Tray restart failed: {e}')
                return
            time.sleep(0.5)
            try:
                icon.stop()
            except Exception:
                pass
        threading.Thread(target=_do, daemon=True).start()

    def _notify(self, message: str, title: str = 'Empir3 Bridge') -> None:
        try:
            if self._icon:
                self._icon.notify(message, title)
        except Exception as e:
            logger.warning('notify failed: %s', e)

    def _uninstall(self, icon, _item=None):
        # Full wipe: stops daemon + tray, clears auth + settings + logs +
        # autostart + Start Menu shortcut + cached payloads + Chrome profile.
        #
        # Reassurance flow: confirm (Yes/No) → "Uninstalling…" balloon →
        # spawn the bootstrapper's --uninstall → quit. The bootstrapper kills
        # this tray as its FIRST cleanup step, so we can't show the
        # "uninstall complete" message ourselves — by then we're gone. That
        # final confirmation is shown by the bootstrapper (payload-entry.js)
        # once the wipe finishes; the balloon bridges the gap until then.
        def _do():
            if not _confirm_uninstall():
                logger.info('uninstall: cancelled at confirmation')
                return

            # Resolve via the same chain as the daemon-spawn path. The frozen
            # tray lives in payload/<version>/ but the bootstrapper sits in
            # %APPDATA%/Empir3/, so the old sibling-only check always missed.
            bootstrap = resolve_bootstrap_exe()
            if not bootstrap:
                logger.warning('uninstall: bootstrapper not found; cannot clean up')
                _message_box(
                    'Could not find Empir3Setup.exe to finish the uninstall.\n\n'
                    'Try reinstalling and uninstalling again, or remove the '
                    'Empir3 folders manually.',
                    'Uninstall Empir3',
                    _MB_OK | _MB_ICONERROR | _MB_SETFOREGROUND | _MB_TOPMOST,
                )
                return

            bootstrap_path = Path(bootstrap)
            logger.info('uninstall: spawning %s --uninstall', bootstrap_path)
            self._notify('Uninstalling Empir3… this takes a few seconds.')
            try:
                subprocess.Popen(
                    [str(bootstrap_path), '--uninstall'],
                    cwd=str(bootstrap_path.parent),
                    creationflags=CREATE_NO_WINDOW,
                )
            except Exception as e:
                logger.error('uninstall: spawn failed: %s', e)
                _message_box(
                    f'The uninstall could not start:\n\n{e}',
                    'Uninstall Empir3',
                    _MB_OK | _MB_ICONERROR | _MB_SETFOREGROUND | _MB_TOPMOST,
                )
                return

            time.sleep(0.8)  # give the balloon a moment to render before we go
            self._poller.stop()
            self._supervisor.stop(clean_ports=True)
            self._clean_ports_on_final_stop = False
            try:
                icon.stop()
            except Exception:
                pass
        threading.Thread(target=_do, daemon=True).start()

    def _quit(self, icon, _item=None):
        logger.info('quit requested')
        def _do():
            self._poller.stop()
            self._updater.stop()
            self._supervisor.stop(clean_ports=True)
            self._clean_ports_on_final_stop = False
            try:
                icon.stop()
            except Exception as e:
                logger.warning('icon.stop failed: %s', e)
        threading.Thread(target=_do, daemon=False).start()

    # ── Menu construction ──

    def _menu(self) -> pystray.Menu:
        return pystray.Menu(
            pystray.MenuItem(lambda _: f'Empir3 — {self._device_label()}', None, enabled=False),
            pystray.MenuItem(self._version_label, None, enabled=False),
            pystray.MenuItem(self._status_label, None, enabled=False),
            pystray.Menu.SEPARATOR,
            # Sign in surfaces any time the daemon has no Empir3 auth. That
            # includes standalone Claude Code mode, where users may still want
            # to pair this bridge with Empir3 later.
            # Lambda visibility is re-evaluated on every menu open.
            pystray.MenuItem('Sign in', self._sign_in,
                             visible=lambda _: not self._last_status.get('has_auth')),
            pystray.MenuItem('Switch Empir3 account', self._sign_out,
                             visible=lambda _: self._last_status.get('has_auth')),
            pystray.MenuItem('Open welcome', self._open_welcome, default=True),
            pystray.MenuItem('Open bridge', self._open_bridge),
            pystray.MenuItem('Open log', self._open_log),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem('Open desktop toolbar', self._open_desktop_toolbar),
            pystray.MenuItem('Select region for agent…', self._select_region_for_agent),
            pystray.MenuItem('Release focus', self._release_agent_focus),
            pystray.MenuItem('Hide agent pointer', self._hide_agent_pointer,
                             visible=lambda _: self._has_pointer()),
            pystray.MenuItem('Show focus grid', self._toggle_focus_grid,
                             visible=lambda _: self._has_focus(),
                             checked=lambda _: self._focus_grid_running()),
            pystray.MenuItem('Calibrate agent clicks…', self._calibrate_pointer),
            pystray.MenuItem('Updates', self._updates_submenu()),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem('Reconnect daemon', self._reconnect),
            pystray.MenuItem('Sign out', self._sign_out,
                             visible=lambda _: self._last_status.get('has_auth')),
            # Surfaces only when a newer tray binary is sitting on disk
            # (after a payload update bumps the tray exe but the running
            # process is the old one).
            pystray.MenuItem('Restart tray (apply update)', self._restart_tray,
                             visible=lambda _: self._tray_update_available()),
            pystray.MenuItem('Uninstall Empir3', self._uninstall),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem('Quit Empir3', self._quit),
        )

    def _updates_submenu(self) -> pystray.Menu:
        return pystray.Menu(
            pystray.MenuItem('Check for updates', self._check_for_updates),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem('Auto-update',
                             self._toggle_auto_update,
                             checked=lambda _: get_auto_update()),
        )

    def _version_label(self, _item) -> str:
        # Show the running daemon version (truth: what's actually serving
        # tools right now). Fall back to the tray's bundled version when
        # the daemon hasn't responded yet.
        s = self._last_status
        ver = s.get('daemon_version') or self._tray_version
        if self._tray_update_available():
            return f'v{ver}  (tray restart pending)'
        return f'v{ver}'

    def _tray_update_available(self) -> bool:
        """True when the active payload contains a newer tray exe than the
        one currently running."""
        return is_newer(get_active_payload_version(), self._tray_version)

    def _status_label(self, _item) -> str:
        s = self._last_status
        if not s.get('reachable'):
            return '○ Daemon not running'
        # No auth yet → daemon is in splash mode; the misleading
        # "Disconnected (relay)" label confuses users who think the relay
        # itself is down.
        if not s.get('has_auth'):
            if s.get('standalone'):
                return '○ Standalone (Claude Code mode)'
            return '○ Signed out — click "Sign in"'
        if s.get('connected'):
            email = s.get('user_email') or 'connected'
            return f'● Connected · {email}'
        if s.get('auth_rejected'):
            return '● Bridge running · sign in needed'
        email = s.get('user_email') or 'paired'
        return f'● Bridge running · {email}'

    # ── Run ──

    def run(self):
        logger.info('empir3 tray starting (frozen=%s, tray_version=%s)',
                    getattr(sys, 'frozen', False), self._tray_version)
        if not _acquire_single_instance():
            return
        self._supervisor.start()
        self._poller.start()
        self._updater.start()
        self._icon = pystray.Icon(
            'empir3-bridge',
            icon=_create_icon_image(False),
            title='Empir3 — starting',
            menu=self._menu(),
        )
        try:
            self._icon.run()
        finally:
            logger.info('icon.run returned, shutting down')
            self._poller.stop()
            self._updater.stop()
            self._supervisor.stop(clean_ports=self._clean_ports_on_final_stop)


def _cleanup_at_exit():
    # Job Object closes when this process dies → all assigned children die too.
    if _JOB_HANDLE and sys.platform == 'win32':
        try:
            import ctypes
            ctypes.windll.kernel32.CloseHandle(_JOB_HANDLE)
        except Exception:
            pass


atexit.register(_cleanup_at_exit)


def main():
    try:
        EmpirTray().run()
    except KeyboardInterrupt:
        logger.info('interrupted')
        sys.exit(0)


if __name__ == '__main__':
    main()
