/**
 * The mirror never writes what it was not given, and never calls an abandoned
 * hydration complete.
 *
 * Two customer cards, one customer (jjeckart@protonmail.com):
 *
 *  a7812def — a "restored" file landed on her PC at ZERO bytes while the real
 *  6,086-byte source sat intact elsewhere, and the turn reported the recovery
 *  as done. Production audit row, 2026-09-11T17:58:15.982Z:
 *      desktop:sync:push | delivered |
 *        {"path":"jameson_pattern_mapper/pattern_mapper.py","size":0}
 *  `writeCompanionProjectFile` was reached with `String(params?.content || '')`,
 *  which turns an ABSENT content field into an empty string: a frame that
 *  carried no content truncated the file it named and answered success with
 *  sizeBytes 0. That is the same mechanism that wiped every file this Bridge
 *  had just pushed on 2026-09-10 when an app-facing `project:file:changed`
 *  event reached the writer. Both routes into it have since been filtered;
 *  this is the guard AT the writer, which cannot be routed around.
 *
 *  7ed38615 / 31ae9f13 — "Mirror sync before start: complete, 1 file(s)
 *  hydrated" for a sync the server had abandoned after one file. The tracker
 *  here only sees pushes that REACHED this machine, so an abandoned hydration
 *  looked clean. The server now sends `incomplete` / `refused` on
 *  desktop:sync:complete and this Bridge must read them.
 *
 * REFUSAL PROOFS: restore `content || ''` or drop the `refuseContentlessWrite`
 * call and the source contract fails; make `describeSyncOutcome` print the
 * complete sentence for a paused sync and its test fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describeSyncOutcome } from '../src/sync-push-window.js';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

test('a write frame with no content field is refused, not coerced to an empty file', () => {
  assert.match(server, /function refuseContentlessWrite\(params: any, relPath: string\)/);
  assert.match(server, /if \(content === undefined \|\| content === null\) \{/);
  assert.match(server, /A write with no content would have emptied the file and reported success\./);

  // Both writer entry points call it BEFORE writing…
  for (const marker of ["if (type === 'desktop:project:file') {", "if (type === 'desktop:sync:push') {"]) {
    const at = server.indexOf(marker);
    assert.ok(at > 0, `entry point present: ${marker}`);
    const body = server.slice(at, at + 900);
    assert.match(body, /const missing = refuseContentlessWrite\(params, params\?\.path \|\| ''\);/);
    assert.ok(body.indexOf('refuseContentlessWrite') < body.indexOf('writeCompanionProjectFile'));
    // …and the silent coercion is gone: `?? ''` keeps an EXPLICIT empty string
    // working (a caller may legitimately mean "make this file empty"), while
    // `|| ''` also swallowed undefined.
    assert.match(body, /String\(params\?\.content \?\? ''\)/);
    assert.doesNotMatch(body, /String\(params\?\.content \|\| ''\)/);
  }
});

test('an abandoned hydration is reported INCOMPLETE, never complete', () => {
  const said = describeSyncOutcome({
    requested: true, completed: true, written: 1, totalPushed: 1, failed: [],
    serverPaused: true, serverPausedAt: 'pc-cleanup/cleanup-phase12.ps1',
  });
  assert.match(said, /INCOMPLETE/);
  assert.match(said, /stopped answering at pc-cleanup\/cleanup-phase12\.ps1/);
  assert.match(said, /the rest were never sent/);
  assert.doesNotMatch(said, /complete, 1 file\(s\) written/);
});

test('a genuinely clean sync still reads as clean', () => {
  const said = describeSyncOutcome({ requested: true, completed: true, written: 9, totalPushed: 9, failed: [] });
  assert.match(said, /^Mirror sync before start: complete, 9 file\(s\) written to the mirror\./);
  assert.match(said, /eligible project files only/);
});

test('refusals from either half are named, and the server report is read off the wire', () => {
  const said = describeSyncOutcome({
    requested: true, completed: true, written: 2,
    failed: [{ path: 'a.ps1', error: 'File type not allowed: .ps1' }],
  });
  assert.match(said, /1 REFUSED/);
  assert.match(said, /a\.ps1 \(File type not allowed: \.ps1\)/);

  // desktop:sync:complete must carry the server's flags through, not drop them.
  const at = server.indexOf("if (type === 'desktop:sync:complete') {");
  const handler = server.slice(at, at + 600);
  assert.match(handler, /incomplete: params\?\.incomplete === true/);
  assert.match(handler, /refused: Array\.isArray\(params\?\.refused\) \? params\.refused : \[\]/);
  // And the job's sync summary must surface them.
  assert.match(server, /serverPaused: outcome\.report\.incomplete === true/);
});
