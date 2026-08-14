'use strict';

const { createHash } = require('node:crypto');
const {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} = require('node:fs');
const fsp = require('node:fs/promises');
const { homedir } = require('node:os');
const { basename, isAbsolute, join, relative, resolve, sep } = require('node:path');
const { spawn } = require('node:child_process');
const { readPersistentJson, writePersistentJson } = require('./persistent-json.js');

const INDEX_VERSION = 1;
const MAX_FILES = 20_000;
const MAX_NOTE_BYTES = 2 * 1024 * 1024;
const MAX_INDEXED_CHARS_PER_NOTE = 96 * 1024;
const MAX_INDEXED_CHARS_TOTAL = 64 * 1024 * 1024;
const DEFAULT_EXCLUDES = ['.obsidian', '.trash', '.git', 'node_modules'];
const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu;

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function normalizeSlashes(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
}

function cleanRelativePath(value) {
  const candidate = normalizeSlashes(value);
  if (!candidate || candidate.includes('\0') || isAbsolute(String(value || ''))) return null;
  const parts = candidate.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return parts.join('/');
}

function uniquePaths(values, fallback = []) {
  const source = Array.isArray(values) ? values : fallback;
  return [...new Set(source.map(cleanRelativePath).filter(Boolean))].slice(0, 100);
}

function underRoot(candidate, root) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function isExcluded(relativePath, excludes) {
  const path = normalizeSlashes(relativePath);
  const parts = path.split('/');
  if (parts.some((part) => part.startsWith('.'))) return true;
  return excludes.some((entry) => path === entry || path.startsWith(`${entry}/`));
}

function isIncluded(relativePath, includes) {
  if (includes.length === 0) return true;
  const path = normalizeSlashes(relativePath);
  return includes.some((entry) => path === entry || path.startsWith(`${entry}/`));
}

function frontmatter(text) {
  if (!text.startsWith('---')) return '';
  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match ? match[1] : '';
}

function noteMetadata(relativePath, text) {
  const fm = frontmatter(text);
  const titleMatch = fm.match(/^title\s*:\s*["']?(.+?)["']?\s*$/im);
  const fallbackTitle = basename(relativePath).replace(/\.md$/i, '').replace(/[-_]+/g, ' ');
  const title = String(titleMatch?.[1] || fallbackTitle).trim().slice(0, 240);
  const headings = [];
  for (const match of text.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    headings.push(String(match[1]).trim().slice(0, 240));
    if (headings.length >= 80) break;
  }
  const tags = new Set();
  const tagLine = fm.match(/^tags\s*:\s*(.+)$/im)?.[1] || '';
  for (const tag of tagLine.replace(/[\[\]"']/g, '').split(/[\s,]+/)) {
    const cleaned = tag.replace(/^#/, '').trim().toLowerCase();
    if (cleaned) tags.add(cleaned.slice(0, 80));
  }
  for (const match of text.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)) {
    tags.add(match[1].toLowerCase().slice(0, 80));
    if (tags.size >= 100) break;
  }
  return { title, headings, tags: [...tags] };
}

function tokenize(value) {
  return [...new Set((String(value || '').toLowerCase().match(TOKEN_RE) || []).filter((token) => token.length > 1))].slice(0, 40);
}

function countOccurrences(haystack, needle, cap = 12) {
  let count = 0;
  let at = 0;
  while (count < cap) {
    at = haystack.indexOf(needle, at);
    if (at < 0) break;
    count += 1;
    at += Math.max(1, needle.length);
  }
  return count;
}

function matchingHeading(entry, matchAt) {
  if (!Array.isArray(entry.headingOffsets) || entry.headingOffsets.length === 0) return null;
  let current = null;
  for (const heading of entry.headingOffsets) {
    if (heading.offset > matchAt) break;
    current = heading.text;
  }
  return current;
}

function snippetFor(entry, query, terms, maxChars = 700) {
  const lower = entry.contentLower || entry.content.toLowerCase();
  const phrase = String(query || '').trim().toLowerCase();
  let at = phrase ? lower.indexOf(phrase) : -1;
  if (at < 0) {
    for (const term of terms) {
      const found = lower.indexOf(term);
      if (found >= 0 && (at < 0 || found < at)) at = found;
    }
  }
  if (at < 0) at = 0;
  const half = Math.floor(maxChars / 2);
  let start = Math.max(0, at - half);
  let end = Math.min(entry.content.length, start + maxChars);
  if (end - start < maxChars) start = Math.max(0, end - maxChars);
  const raw = entry.content.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${raw}${end < entry.content.length ? '…' : ''}`;
}

function publicEntry(entry, vault, query, terms, includeContent = false) {
  const lower = entry.contentLower || entry.content.toLowerCase();
  let matchAt = String(query || '').trim() ? lower.indexOf(String(query).trim().toLowerCase()) : -1;
  if (matchAt < 0) {
    for (const term of terms) {
      const found = lower.indexOf(term);
      if (found >= 0 && (matchAt < 0 || found < matchAt)) matchAt = found;
    }
  }
  const notePath = entry.relativePath;
  return {
    id: hash(`${vault.vaultId}:${notePath}`).slice(0, 24),
    vaultId: vault.vaultId,
    vaultName: vault.vaultName,
    title: entry.title,
    path: notePath,
    heading: matchingHeading(entry, Math.max(0, matchAt)),
    tags: entry.tags.slice(0, 20),
    modifiedAt: new Date(entry.mtimeMs).toISOString(),
    snippet: snippetFor(entry, query, terms),
    ...(includeContent ? { content: entry.content } : {}),
  };
}

function defaultIndex() {
  return { version: INDEX_VERSION, vaultRealPath: '', scannedAt: null, entries: [] };
}

function normalizeConfig(raw = {}) {
  return {
    connected: !!raw.connected,
    vaultPath: typeof raw.vaultPath === 'string' ? raw.vaultPath : '',
    vaultName: typeof raw.vaultName === 'string' ? raw.vaultName : '',
    vaultId: typeof raw.vaultId === 'string' ? raw.vaultId : '',
    shareWithEmpir3: !!raw.shareWithEmpir3,
    includePaths: uniquePaths(raw.includePaths),
    excludePaths: uniquePaths(raw.excludePaths, DEFAULT_EXCLUDES),
    connectedAt: typeof raw.connectedAt === 'string' ? raw.connectedAt : null,
  };
}

function obsidianConfigPath(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'obsidian', 'obsidian.json');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'obsidian', 'obsidian.json');
}

function discoverObsidianVaults({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const configPath = obsidianConfigPath(platform, env, home);
  let raw;
  try { raw = JSON.parse(readFileSync(configPath, 'utf8')); } catch { return []; }
  const candidates = raw?.vaults && typeof raw.vaults === 'object' ? Object.values(raw.vaults) : [];
  const seen = new Set();
  const vaults = [];
  for (const candidate of candidates) {
    const value = candidate && typeof candidate === 'object' ? candidate : {};
    const configured = String(value.path || '').trim();
    if (!configured || !isAbsolute(configured)) continue;
    let real;
    try {
      real = realpathSync(configured);
      if (!statSync(real).isDirectory()) continue;
    } catch { continue; }
    const key = platform === 'win32' ? real.toLowerCase() : real;
    if (seen.has(key)) continue;
    seen.add(key);
    vaults.push({
      vaultId: hash(real).slice(0, 24),
      name: basename(real),
      path: real,
      lastOpened: Number(value.ts || 0) || null,
      open: !!value.open,
    });
  }
  return vaults.sort((a, b) => Number(b.open) - Number(a.open) || Number(b.lastOpened || 0) - Number(a.lastOpened || 0));
}

function launchUri(uri, platform = process.platform) {
  let child;
  if (platform === 'win32') {
    child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Start-Process -FilePath $env:EMPIR3_OBSIDIAN_URI',
    ], {
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, EMPIR3_OBSIDIAN_URI: uri },
    });
    // Keep the short-lived shell helper referenced until ShellExecute has
    // handed the URI to Obsidian. A detached PowerShell process can exit
    // before the protocol activation completes on Windows.
    return;
  }
  else if (platform === 'darwin') child = spawn('open', [uri], { detached: true, stdio: 'ignore' });
  else child = spawn('xdg-open', [uri], { detached: true, stdio: 'ignore' });
  child.unref();
}

class ObsidianKnowledgeService {
  constructor({ getSettings, saveSettings, indexFile, platform = process.platform, openUri = launchUri }) {
    if (typeof getSettings !== 'function' || typeof saveSettings !== 'function') throw new Error('ObsidianKnowledgeService requires settings accessors');
    this.getSettings = getSettings;
    this.saveSettings = saveSettings;
    this.indexFile = indexFile;
    this.platform = platform;
    this.openUri = openUri;
    this.index = null;
    this.refreshPromise = null;
  }

  config() {
    return normalizeConfig(this.getSettings()?.obsidian);
  }

  loadIndex() {
    if (this.index) return this.index;
    this.index = readPersistentJson(this.indexFile, {
      defaultValue: defaultIndex,
      mode: 0o600,
      validate: (value) => value && value.version === INDEX_VERSION && Array.isArray(value.entries),
      writeDefault: true,
    });
    return this.index;
  }

  saveIndex(index) {
    this.index = index;
    writePersistentJson(this.indexFile, index, { mode: 0o600 });
  }

  updateConfig(patch) {
    const settings = this.getSettings();
    const next = normalizeConfig({ ...settings.obsidian, ...patch });
    this.saveSettings({ ...settings, obsidian: next });
    return next;
  }

  discover() {
    return discoverObsidianVaults();
  }

  async connect({ vaultPath, shareWithEmpir3 = false, includePaths = [], excludePaths = DEFAULT_EXCLUDES } = {}) {
    const input = String(vaultPath || '').trim();
    if (!input || !isAbsolute(input)) throw new Error('Choose an absolute Obsidian vault folder');
    let real;
    try {
      real = await fsp.realpath(resolve(input));
      if (!(await fsp.stat(real)).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new Error('That Obsidian vault folder could not be read');
    }
    let obsidianMetadata;
    try { obsidianMetadata = await fsp.stat(join(real, '.obsidian')); } catch { obsidianMetadata = null; }
    if (!obsidianMetadata?.isDirectory()) {
      throw new Error('That folder does not look like an Obsidian vault (.obsidian is missing)');
    }
    const previousSettings = this.getSettings();
    const previousIndex = this.loadIndex();
    const config = this.updateConfig({
      connected: true,
      vaultPath: real,
      vaultName: basename(real),
      vaultId: hash(real).slice(0, 24),
      shareWithEmpir3: !!shareWithEmpir3,
      includePaths: uniquePaths(includePaths),
      excludePaths: uniquePaths(excludePaths, DEFAULT_EXCLUDES),
      connectedAt: new Date().toISOString(),
    });
    this.index = null;
    try {
      const scan = await this.refresh({ force: true });
      return { ...this.publicStatus(config, scan), discovered: this.discover() };
    } catch (error) {
      // Connecting is transactional: a failed first scan must not replace a
      // previously working vault or leave a half-connected configuration.
      this.saveSettings(previousSettings);
      this.saveIndex(previousIndex);
      throw error;
    }
  }

  async setSharing(enabled) {
    const config = this.config();
    if (!config.connected) throw new Error('Connect an Obsidian vault first');
    const next = this.updateConfig({ shareWithEmpir3: !!enabled });
    return this.publicStatus(next);
  }

  async disconnect() {
    this.updateConfig({
      connected: false,
      vaultPath: '',
      vaultName: '',
      vaultId: '',
      shareWithEmpir3: false,
      connectedAt: null,
    });
    this.saveIndex(defaultIndex());
    return this.publicStatus(this.config());
  }

  assertConnected({ requireSharing = false } = {}) {
    const config = this.config();
    if (!config.connected || !config.vaultPath) throw new Error('No Obsidian vault is connected on this Bridge');
    if (requireSharing && !config.shareWithEmpir3) throw new Error('Obsidian sharing is off on this Bridge. Turn on “Available to my Empir3 agents” in the Bridge console.');
    let root;
    try {
      root = realpathSync(config.vaultPath);
      if (!statSync(root).isDirectory()) throw new Error('not a directory');
    } catch { throw new Error('The connected Obsidian vault is unavailable on this computer'); }
    return { config, root };
  }

  publicStatus(config = this.config(), scan = null) {
    const index = this.loadIndex();
    const activeIndex = scan || index;
    return {
      success: true,
      connected: !!config.connected,
      shared: !!config.shareWithEmpir3,
      vaultId: config.vaultId || null,
      vaultName: config.vaultName || null,
      vaultPath: config.connected ? config.vaultPath : null,
      includePaths: config.includePaths,
      excludePaths: config.excludePaths,
      connectedAt: config.connectedAt,
      noteCount: activeIndex?.entries?.length || activeIndex?.noteCount || 0,
      skippedCount: activeIndex?.skippedCount || 0,
      truncated: !!activeIndex?.truncated,
      scannedAt: activeIndex?.scannedAt || null,
    };
  }

  async refresh({ force = false } = {}) {
    if (!force) {
      const cached = this.loadIndex();
      const scannedAt = Date.parse(cached.scannedAt || '');
      if (cached.vaultRealPath && Number.isFinite(scannedAt) && Date.now() - scannedAt < 15_000) return cached;
    }
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this._refresh({ force }).finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  async _refresh({ force = false } = {}) {
    const { config, root } = this.assertConnected();
    const old = this.loadIndex();
    const oldByPath = old.vaultRealPath === root
      ? new Map(old.entries.map((entry) => [entry.relativePath, entry]))
      : new Map();
    const entries = [];
    let indexedChars = 0;
    let skippedCount = 0;
    let truncated = false;
    const includes = config.includePaths;
    const excludes = config.excludePaths;

    const walk = async (directory) => {
      const dirents = await fsp.readdir(directory, { withFileTypes: true });
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      for (const dirent of dirents) {
        if (entries.length >= MAX_FILES || indexedChars >= MAX_INDEXED_CHARS_TOTAL) { truncated = true; return; }
        const absolute = join(directory, dirent.name);
        const rel = normalizeSlashes(relative(root, absolute));
        if (!rel || isExcluded(rel, excludes)) continue;
        if (dirent.isSymbolicLink()) { skippedCount += 1; continue; }
        if (dirent.isDirectory()) {
          const couldContainIncluded = includes.length === 0 || includes.some((entry) => entry === rel || entry.startsWith(`${rel}/`) || rel.startsWith(`${entry}/`));
          if (couldContainIncluded) await walk(absolute);
          continue;
        }
        if (!dirent.isFile() || !/\.md$/i.test(dirent.name) || !isIncluded(rel, includes)) continue;
        let realFile;
        let info;
        try {
          realFile = await fsp.realpath(absolute);
          if (!underRoot(realFile, root)) { skippedCount += 1; continue; }
          info = await fsp.stat(realFile);
        } catch { skippedCount += 1; continue; }
        if (info.size > MAX_NOTE_BYTES) { skippedCount += 1; continue; }
        const cached = oldByPath.get(rel);
        if (!force && cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
          entries.push(cached);
          indexedChars += cached.content.length;
          continue;
        }
        let content;
        try { content = await fsp.readFile(realFile, 'utf8'); } catch { skippedCount += 1; continue; }
        content = content.slice(0, MAX_INDEXED_CHARS_PER_NOTE);
        if (indexedChars + content.length > MAX_INDEXED_CHARS_TOTAL) { truncated = true; return; }
        const meta = noteMetadata(rel, content);
        const headingOffsets = [];
        for (const match of content.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
          headingOffsets.push({ offset: match.index || 0, text: String(match[1]).trim().slice(0, 240) });
          if (headingOffsets.length >= 80) break;
        }
        entries.push({
          relativePath: rel,
          title: meta.title,
          headings: meta.headings,
          headingOffsets,
          tags: meta.tags,
          mtimeMs: info.mtimeMs,
          size: info.size,
          content,
        });
        indexedChars += content.length;
        if (entries.length % 100 === 0) await new Promise((resolvePromise) => setImmediate(resolvePromise));
      }
    };

    await walk(root);
    const next = {
      version: INDEX_VERSION,
      vaultRealPath: root,
      scannedAt: new Date().toISOString(),
      skippedCount,
      truncated,
      entries,
    };
    this.saveIndex(next);
    return next;
  }

  async status({ requireSharing = false, includePath = true } = {}) {
    const config = this.config();
    if (requireSharing && (!config.connected || !config.shareWithEmpir3)) {
      // Remote callers may learn only whether the local lending switch is on.
      // Vault identity, size, scan time, and paths stay private until it is.
      return {
        success: true,
        connected: !!config.connected,
        shared: false,
        vaultId: null,
        vaultName: null,
        noteCount: 0,
        skippedCount: 0,
        truncated: false,
        scannedAt: null,
      };
    }
    const status = this.publicStatus(config);
    if (!includePath) delete status.vaultPath;
    return status;
  }

  async search({ query, limit = 5, requireSharing = true } = {}) {
    const { config } = this.assertConnected({ requireSharing });
    const cleanQuery = String(query || '').trim().slice(0, 500);
    if (!cleanQuery) throw new Error('Obsidian search requires a query');
    const terms = tokenize(cleanQuery);
    if (terms.length === 0) throw new Error('Obsidian search query has no searchable terms');
    const index = await this.refresh();
    const phrase = cleanQuery.toLowerCase();
    const scored = [];
    for (const entry of index.entries) {
      const title = entry.title.toLowerCase();
      const path = entry.relativePath.toLowerCase();
      const headings = entry.headings.join(' ').toLowerCase();
      const tags = entry.tags.join(' ').toLowerCase();
      const content = entry.content.toLowerCase();
      let score = 0;
      if (title === phrase) score += 140;
      if (title.includes(phrase)) score += 70;
      if (path.includes(phrase)) score += 45;
      if (headings.includes(phrase)) score += 35;
      if (content.includes(phrase)) score += 25;
      for (const term of terms) {
        if (title.includes(term)) score += 20;
        if (path.includes(term)) score += 12;
        if (tags.includes(term)) score += 16;
        if (headings.includes(term)) score += 10;
        score += Math.min(10, countOccurrences(content, term));
      }
      if (score > 0) scored.push({ entry, score });
    }
    const take = Math.max(1, Math.min(10, Number(limit) || 5));
    const hits = scored
      .sort((a, b) => b.score - a.score || b.entry.mtimeMs - a.entry.mtimeMs || a.entry.relativePath.localeCompare(b.entry.relativePath))
      .slice(0, take)
      .map(({ entry, score }) => ({ ...publicEntry(entry, config, cleanQuery, terms), score }));
    return {
      success: true,
      vaultId: config.vaultId,
      vaultName: config.vaultName,
      query: cleanQuery,
      scannedAt: index.scannedAt,
      totalNotes: index.entries.length,
      hits,
    };
  }

  async read({ path, maxChars = 12_000, requireSharing = true } = {}) {
    const { config, root } = this.assertConnected({ requireSharing });
    const rel = cleanRelativePath(path);
    if (!rel || !/\.md$/i.test(rel)) throw new Error('Choose a Markdown note path returned by Obsidian search');
    const index = await this.refresh();
    const entry = index.entries.find((candidate) => candidate.relativePath === rel);
    if (!entry) throw new Error('That note is not in the connected Obsidian index');
    const absolute = resolve(root, ...rel.split('/'));
    let real;
    try {
      if (lstatSync(absolute).isSymbolicLink()) throw new Error('symlink');
      real = realpathSync(absolute);
    } catch { throw new Error('That Obsidian note is no longer available'); }
    if (!underRoot(real, root)) throw new Error('Obsidian note escaped the connected vault');
    const currentInfo = statSync(real);
    if (!currentInfo.isFile() || currentInfo.size > MAX_NOTE_BYTES) {
      throw new Error('That Obsidian note is too large to read through the Bridge');
    }
    const current = readFileSync(real, 'utf8');
    const cap = Math.max(500, Math.min(40_000, Number(maxChars) || 12_000));
    const publicNote = publicEntry({ ...entry, content: current.slice(0, cap), headingOffsets: entry.headingOffsets }, config, '', [], true);
    publicNote.truncated = current.length > cap;
    return { success: true, note: publicNote };
  }

  async open({ path, requireSharing = true } = {}) {
    const { config, root } = this.assertConnected({ requireSharing });
    const rel = cleanRelativePath(path);
    if (!rel || !/\.md$/i.test(rel)) throw new Error('Choose a Markdown note path returned by Obsidian search');
    const index = await this.refresh();
    if (!index.entries.some((entry) => entry.relativePath === rel)) throw new Error('That note is not in the connected Obsidian index');
    const absolute = resolve(root, ...rel.split('/'));
    let real;
    try {
      if (lstatSync(absolute).isSymbolicLink()) throw new Error('symlink');
      real = realpathSync(absolute);
    } catch { throw new Error('That Obsidian note is no longer available'); }
    if (!underRoot(real, root)) throw new Error('Obsidian note escaped the connected vault');
    // URLSearchParams serializes spaces as "+", but Obsidian's Windows URI
    // handler expects percent-encoded path characters (not form encoding).
    const uri = `obsidian://open?path=${encodeURIComponent(real)}`;
    this.openUri(uri, this.platform);
    return { success: true, vaultId: config.vaultId, vaultName: config.vaultName, path: rel };
  }
}

module.exports = {
  DEFAULT_EXCLUDES,
  ObsidianKnowledgeService,
  cleanRelativePath,
  discoverObsidianVaults,
  normalizeConfig,
  underRoot,
};
