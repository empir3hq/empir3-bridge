"""
PyInstaller build for the Empir3 tray wrapper.

Produces:  bridge/build/dist/Empir3Tray.exe   (Windows-only for now)

Run:
    cd bridge/tray
    pip install -r requirements.txt pyinstaller
    python build.py

The output exe is dropped beside Empir3Setup.exe in the install dir. At
runtime the tray spawns `Empir3Setup.exe --daemon-real` from its own dir.

Single-file (--onefile) so the bootstrapper payload only needs to extract one
artifact. --windowed so no console flashes when Windows autostart launches it.
"""
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TRAY_PY = HERE / 'tray.py'
DIST_DIR = HERE.parent / 'build' / 'dist'
WORK_DIR = HERE.parent / 'build' / 'pyinstaller-work'
SPEC_DIR = HERE.parent / 'build' / 'pyinstaller-spec'


def main():
    if sys.platform != 'win32':
        print('[tray-build] WARN: only tested on Windows; macOS support deferred.')

    if not TRAY_PY.exists():
        print(f'[tray-build] FATAL: {TRAY_PY} not found')
        sys.exit(1)

    # Clean prior build artifacts so the binary stamp is reproducible.
    for d in (WORK_DIR, SPEC_DIR):
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)
    DIST_DIR.mkdir(parents=True, exist_ok=True)

    args = [
        sys.executable, '-m', 'PyInstaller',
        '--noconfirm',
        '--clean',
        '--onefile',
        '--windowed',                # no console window
        '--name', 'Empir3Tray',
        '--distpath', str(DIST_DIR),
        '--workpath', str(WORK_DIR),
        '--specpath', str(SPEC_DIR),
        # pystray ships a Windows backend that PyInstaller doesn't always
        # auto-discover — pin it explicitly.
        '--hidden-import', 'pystray._win32',
        '--hidden-import', 'PIL._tkinter_finder',
        str(TRAY_PY),
    ]

    print('[tray-build]', ' '.join(args))
    r = subprocess.run(args, check=False)
    if r.returncode != 0:
        print(f'[tray-build] FAILED (exit {r.returncode})')
        sys.exit(r.returncode)

    out = DIST_DIR / ('Empir3Tray.exe' if sys.platform == 'win32' else 'Empir3Tray')
    if not out.exists():
        print(f'[tray-build] FAILED: expected output {out} not found')
        sys.exit(1)

    size_mb = out.stat().st_size / (1024 * 1024)
    print(f'[tray-build] OK: {out} ({size_mb:.1f} MB)')


if __name__ == '__main__':
    main()
