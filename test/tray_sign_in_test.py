"""Tray "Sign in" must always open a sign-in page (Work Board 802e566a).

A Windows customer clicked Sign in repeatedly on Bridge 0.4.10 and saw nothing:
no window, no error, no code. Sign in only drives the controlled Bridge Chrome,
and when that browser cannot be opened (no Chrome at the paths the Bridge
knows, a per-user install, a profile lock) the only signal was a tray toast.
The welcome page is served by the local daemon and works in any browser, so a
failed controlled open must fall back to the default browser.

Runs the real `_sign_in` method extracted from tray.py, without importing the
tray module (that would start pystray and Windows handles).
"""
import ast
import pathlib
import types
import unittest
from unittest.mock import Mock

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'tray' / 'tray.py'
TREE = ast.parse(SOURCE.read_text(encoding='utf-8-sig'))
TRAY = next(n for n in TREE.body if isinstance(n, ast.ClassDef) and n.name == 'EmpirTray')
METHOD = next(n for n in TRAY.body if isinstance(n, ast.FunctionDef) and n.name == '_sign_in')


class SignInTests(unittest.TestCase):
    def setUp(self):
        self.browser = Mock()
        namespace = {
            'logger': Mock(),
            'webbrowser': types.SimpleNamespace(open=self.browser),
        }
        exec(compile(ast.Module(body=[METHOD], type_ignores=[]), str(SOURCE), 'exec'), namespace)
        self.sign_in = namespace['_sign_in']
        self.tray = types.SimpleNamespace(
            _last_status={'port': 14167},
            _notify=Mock(),
            _welcome_url=lambda port: f'http://127.0.0.1:{port}/welcome',
            _open_controlled_url=Mock(return_value=True),
        )

    def test_controlled_browser_opens_welcome(self):
        self.sign_in(self.tray)
        self.tray._open_controlled_url.assert_called_once_with(
            14167, 'http://127.0.0.1:14167/welcome', 'sign-in')
        self.browser.assert_not_called()

    def test_failed_controlled_browser_falls_back_to_default_browser(self):
        self.tray._open_controlled_url.return_value = False
        self.sign_in(self.tray)
        self.browser.assert_called_once_with('http://127.0.0.1:14167/welcome')

    def test_raising_controlled_browser_falls_back_to_default_browser(self):
        self.tray._open_controlled_url.side_effect = RuntimeError('Chrome not found. Set CHROME_PATH env var.')
        self.sign_in(self.tray)
        self.browser.assert_called_once_with('http://127.0.0.1:14167/welcome')

    def test_no_daemon_still_tells_the_user(self):
        self.tray._last_status = {}
        self.sign_in(self.tray)
        self.tray._notify.assert_called_once()
        self.tray._open_controlled_url.assert_not_called()


if __name__ == '__main__':
    unittest.main()
