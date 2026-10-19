/**
 * Shell "code surface" — the part of a command that can actually run.
 *
 * KEEP IN SYNC with empir3-release `server/src/services/shellSurface.ts`,
 * which is the same parser with the same three fail-closed properties. That
 * copy carries the full rationale; the short version:
 *
 *   A guard that regexes the raw command string cannot tell an instruction
 *   from a payload. Card f7d2fe85 (jjeckart@protonmail.com): a desktop
 *   command whose payload string described "34 days without a reboot" was
 *   refused as "Command blocked: system reboot". The word was inside quotes
 *   and could never restart anything.
 *
 * blankDataRegions() replaces the data regions — single-quoted strings,
 * double-quoted strings, heredoc bodies, comments, backslash-escaped
 * metacharacters — with spaces, at the same offsets, so a guard sees the
 * executable structure and nothing else.
 *
 * Fail-closed, in order:
 *  1. Blanking only ever REMOVES characters, so data can never make a guard
 *     fire that the raw text would not have.
 *  2. A string handed to something that EXECUTES strings is code, not data.
 *     If a shell, interpreter or wrapper survives on the surface
 *     (`sh -c '...'`, `Invoke-Expression '...'`, `echo '...' | sh`), the raw
 *     command is handed back instead.
 *  3. Anything that does not parse to completion — unterminated quote or
 *     heredoc — returns the raw command.
 *
 * PowerShell note: this parser is POSIX-shaped, and the differences all fail
 * in the safe direction. A PowerShell here-string (@'...'@) is read as an
 * ordinary single-quoted string, which blanks the same bytes. A backtick in
 * a double-quoted PowerShell string is read as command substitution, which
 * leaves that text as CODE — the guard stays as strict as it is today.
 */

'use strict';

const SHELL_METACHARACTERS = new Set([
  '&', '|', ';', '<', '>', '(', ')', '{', '}', '$', '`', '"', "'", ' ', '\t', '*', '?', '[', ']', '~', '#', '!',
]);

const CODE_BEARING_WORDS = new Set([
  // shells
  'sh', 'bash', 'zsh', 'dash', 'ash', 'ksh', 'busybox', 'pwsh', 'powershell', 'cmd',
  // string evaluation (POSIX + PowerShell)
  'eval', 'source', 'command', 'invoke-expression', 'iex', 'invoke-command', 'start-process', 'start-job',
  // wrappers that forward an argv to something else
  'sudo', 'doas', 'su', 'env', 'nohup', 'setsid', 'timeout', 'nice', 'ionice',
  'stdbuf', 'xargs', 'watch', 'flock', 'chroot', 'unshare', 'nsenter',
  // remote / container execution
  'ssh', 'docker', 'podman', 'kubectl', 'pct', 'lxc', 'virsh',
  // interpreters with a -c/-e string form
  'python', 'python2', 'python3', 'perl', 'ruby', 'node', 'nodejs', 'php', 'lua',
  'awk', 'gawk', 'mawk',
]);

/**
 * @param {string} command
 * @returns {string|null} the blanked surface, or null when unparseable
 */
function blankDataRegions(command) {
  const length = command.length;
  const out = new Array(length);
  /** @type {Array<'sq'|'dq'|'cmdsub'|'backtick'|'heredoc'>} */
  const stack = [];
  /** @type {Array<{delimiter:string, stripTabs:boolean}>} */
  const pendingHeredocs = [];
  let activeHeredoc = null;
  let atLineStart = true;
  let previous = '';
  let index = 0;

  const blank = (at) => { out[at] = command[at] === '\n' ? '\n' : ' '; };

  while (index < length) {
    const char = command[index];
    const top = stack.length ? stack[stack.length - 1] : null;

    if (top === 'heredoc' && activeHeredoc) {
      if (atLineStart) {
        let lineEnd = command.indexOf('\n', index);
        if (lineEnd < 0) lineEnd = length;
        const raw = command.slice(index, lineEnd).replace(/\r$/, '');
        const candidate = activeHeredoc.stripTabs ? raw.replace(/^\t+/, '') : raw;
        if (candidate === activeHeredoc.delimiter) {
          for (let k = index; k < lineEnd; k++) out[k] = ' ';
          index = lineEnd;
          stack.pop();
          activeHeredoc = pendingHeredocs.shift() || null;
          if (activeHeredoc) stack.push('heredoc');
          if (index < length) { out[index] = '\n'; index++; }
          atLineStart = true;
          previous = '\n';
          continue;
        }
      }
      blank(index);
      atLineStart = char === '\n';
      previous = char;
      index++;
      continue;
    }

    if (top === 'sq') {
      if (char === "'") { stack.pop(); out[index] = ' '; } else { blank(index); }
      previous = char;
      index++;
      continue;
    }

    if (top === 'dq') {
      if (char === '"') { stack.pop(); out[index] = ' '; previous = char; index++; continue; }
      if (char === '\\' && index + 1 < length) {
        out[index] = ' ';
        blank(index + 1);
        previous = command[index + 1];
        index += 2;
        continue;
      }
      if (char === '$' && command[index + 1] === '(') {
        stack.push('cmdsub');
        out[index] = '$'; out[index + 1] = '(';
        previous = '('; index += 2; continue;
      }
      if (char === '`') { stack.push('backtick'); out[index] = '`'; previous = char; index++; continue; }
      blank(index);
      previous = char;
      index++;
      continue;
    }

    if (char === '\\' && index + 1 < length) {
      const escaped = command[index + 1];
      out[index] = ' ';
      out[index + 1] = escaped === '\n' ? '\n'
        : SHELL_METACHARACTERS.has(escaped) ? ' '
        : escaped;
      previous = out[index + 1];
      atLineStart = escaped === '\n';
      index += 2;
      continue;
    }

    if (char === "'") { stack.push('sq'); out[index] = ' '; previous = char; index++; continue; }
    if (char === '"') { stack.push('dq'); out[index] = ' '; previous = char; index++; continue; }

    if (char === '`') {
      if (top === 'backtick') stack.pop(); else stack.push('backtick');
      out[index] = '`'; previous = char; index++; continue;
    }

    if (char === '$' && command[index + 1] === '(') {
      stack.push('cmdsub');
      out[index] = '$'; out[index + 1] = '(';
      previous = '('; index += 2; continue;
    }

    if (char === ')' && top === 'cmdsub') { stack.pop(); out[index] = ')'; previous = char; index++; continue; }

    if (char === '#' && (previous === '' || /[\s;|&(]/.test(previous))) {
      let lineEnd = command.indexOf('\n', index);
      if (lineEnd < 0) lineEnd = length;
      for (let k = index; k < lineEnd; k++) out[k] = ' ';
      index = lineEnd;
      previous = ' ';
      continue;
    }

    if (char === '<' && command[index + 1] === '<' && command[index + 2] !== '<') {
      out[index] = '<'; out[index + 1] = '<';
      let cursor = index + 2;
      let stripTabs = false;
      if (command[cursor] === '-') { stripTabs = true; out[cursor] = '-'; cursor++; }
      while (cursor < length && (command[cursor] === ' ' || command[cursor] === '\t')) {
        out[cursor] = command[cursor];
        cursor++;
      }
      let delimiter = '';
      const quote = command[cursor];
      if (quote === "'" || quote === '"') {
        out[cursor] = ' ';
        cursor++;
        while (cursor < length && command[cursor] !== quote) {
          delimiter += command[cursor];
          out[cursor] = ' ';
          cursor++;
        }
        if (cursor >= length) return null;
        out[cursor] = ' ';
        cursor++;
      } else {
        while (cursor < length && /[A-Za-z0-9_.+-]/.test(command[cursor])) {
          delimiter += command[cursor];
          out[cursor] = command[cursor];
          cursor++;
        }
      }
      if (!delimiter) return null;
      pendingHeredocs.push({ delimiter, stripTabs });
      previous = delimiter.slice(-1) || '<';
      index = cursor;
      continue;
    }

    if (char === '\n') {
      out[index] = '\n';
      if (!activeHeredoc && pendingHeredocs.length) {
        activeHeredoc = pendingHeredocs.shift() || null;
        if (activeHeredoc) stack.push('heredoc');
      }
      atLineStart = true;
      previous = char;
      index++;
      continue;
    }

    out[index] = char;
    atLineStart = false;
    previous = char;
    index++;
  }

  if (stack.length || pendingHeredocs.length || activeHeredoc) return null;
  return out.join('');
}

function tokenBasename(token) {
  const tail = token.split(/[\\/]/).pop() || '';
  return tail.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

function containsCodeBearingWord(surface) {
  for (const token of surface.split(/[^A-Za-z0-9_.\\/-]+/)) {
    if (!token) continue;
    if (CODE_BEARING_WORDS.has(tokenBasename(token))) return true;
  }
  return false;
}

/**
 * What a guard should regex: the command with data regions blanked, or the
 * raw command whenever blanking would be unsafe.
 * @param {string} command
 * @returns {string}
 */
function guardScanTarget(command) {
  const text = String(command || '');
  if (!text) return text;
  const surface = blankDataRegions(text);
  if (surface === null) return text;
  if (containsCodeBearingWord(surface)) return text;
  return surface;
}

module.exports = { guardScanTarget, blankDataRegions };
