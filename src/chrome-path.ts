/**
 * Where the Bridge looks for its own Chrome, and what it says when it cannot
 * find one.
 *
 * Chrome's own Windows installer puts chrome.exe under
 * %LOCALAPPDATA%\Google\Chrome\Application when the user has no administrator
 * rights. Until 2026-11-09 the Bridge looked only under Program Files, so on
 * those machines every browser action failed with "Chrome not found. Set
 * CHROME_PATH env var." (Work Board b6430238), and tray Sign in, which opens
 * the welcome page in this browser, did nothing visible (802e566a).
 *
 * This only decides which chrome.exe to START. The Bridge still launches its
 * own Chrome with its own profile and never attaches to the user's window.
 */
import { existsSync } from 'fs';
import { join, posix } from 'path';

type Env = Record<string, string | undefined>;

export function chromeCandidatePaths(env: Env = process.env, platform: string = process.platform): string[] {
  const paths: string[] = [];
  if (env.CHROME_PATH) paths.push(env.CHROME_PATH);
  if (platform === 'win32') {
    paths.push(
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    );
    const localAppData = env.LOCALAPPDATA || (env.USERPROFILE ? join(env.USERPROFILE, 'AppData', 'Local') : '');
    if (localAppData) paths.push(join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    return paths;
  }
  if (platform === 'darwin') {
    paths.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    if (env.HOME) paths.push(posix.join(env.HOME, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
    return paths;
  }
  paths.push(
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',      // Debian/Fedora package name
    '/snap/bin/chromium',     // Ubuntu ships Chromium as a snap
  );
  return paths;
}

export function chromeNotFoundMessage(tried: string[], platform: string = process.platform): string {
  const where = tried.length ? ` Looked in: ${tried.join('; ')}.` : '';
  if (platform === 'darwin') return `Chrome/Chromium not found on this Mac.${where} Install Google Chrome from google.com/chrome in Applications, or set CHROME_PATH to the browser executable inside the app bundle.`;
  return platform === 'win32'
    // Keep "Chrome not found" first: the app recognises a missing browser by
    // it (empir3 bridgePolicyRefusal.ts BROWSER_MISSING_MESSAGE).
    ? `Chrome not found on this computer.${where} Install Google Chrome from google.com/chrome, or set CHROME_PATH to the full path of chrome.exe.`
    : `Chrome/Chromium not found.${where} Install it (e.g. apt install chromium) or set CHROME_PATH.`;
}

export function findChromePath(
  env: Env = process.env,
  platform: string = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  const tried = chromeCandidatePaths(env, platform);
  for (const p of tried) {
    if (exists(p)) return p;
  }
  throw new Error(chromeNotFoundMessage(tried, platform));
}
