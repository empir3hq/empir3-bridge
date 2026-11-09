import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import journalModule from '../src/cli-turn-journal.ts';
import lifecycleModule from '../src/cli-turn-lifecycle.ts';
const { CliTurnJournal, cliTurnHash } = journalModule;
const { CliTurnLifecycle } = lifecycleModule;
const binding = cliTurnHash({ account: 'fixture', device: 'fixture-device' });
function fixture(t, limit) {
  const dir = mkdtempSync(join(tmpdir(), 'empir3-cli-journal-')), file = join(dir, 'turns.sqlite');
  const stores = []; const open = () => { const s = new CliTurnJournal(file, limit); stores.push(s); return s; };
  const dbs = []; const raw = () => { const db = new DatabaseSync(file); dbs.push(db); return db; };
  t.after(() => { for (const s of stores) try { s.close(); } catch {} for (const db of dbs) try { db.close(); } catch {}
    for (const name of readdirSync(dir)) unlinkSync(join(dir, name)); rmdirSync(dir); });
  return { dir, file, open, raw };
}
const prepare = (s, id = 'turn-one') => s.prepare(binding, 'codex', id, { id, prompt: 'PRIVATE-FIXTURE-PROMPT-DO-NOT-STORE' });

test('preparation and issue survive reopen; no prompts or results are stored', t => {
  const f = fixture(t), s = f.open(), receipt = prepare(s);
  assert.deepEqual(s.inspect(receipt), { phase: 'preparing', cancelled: false, outcome: null });
  const db = f.raw(); assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  s.issue(receipt); s.finish(receipt, 'done'); s.close();
  const reopened = f.open(); assert.deepEqual(reopened.inspect(receipt), { phase: 'uncertain', cancelled: false, outcome: 'done' });
  for (const name of readdirSync(f.dir)) assert.equal(readFileSync(join(f.dir, name)).includes(Buffer.from('PRIVATE-FIXTURE-PROMPT-DO-NOT-STORE')), false);
});

test('duplicate or changed input cannot restart an admitted identity, including after completion', t => {
  const s = fixture(t).open(), receipt = prepare(s);
  assert.throws(() => prepare(s), /already admitted/);
  assert.throws(() => s.prepare(cliTurnHash('another owner'), 'codex', receipt.id, { changed: true }), /already admitted/);
  s.finish(receipt, 'refused'); assert.equal(s.inspect(receipt).phase, 'not_started');
  assert.throws(() => prepare(s), /already admitted/); assert.throws(() => s.issue(receipt), /no longer allowed/);
});

test('separate journal connections atomically fence preparation before an old creator can issue', t => {
  const f = fixture(t), first = f.open(), second = f.open(), receipt = prepare(first);
  second.fencePreparation(receipt);
  assert.throws(() => first.issue(receipt), /no longer allowed/);
  assert.deepEqual(first.inspect(receipt), { phase: 'not_started', cancelled: true, outcome: 'refused' });
});

test('issued work cannot be retired by preparation recovery, cancellation or elapsed time', t => {
  const f = fixture(t), s = f.open(), receipt = prepare(s); s.issue(receipt);
  f.raw().prepare('UPDATE cli_turns SET created_at=1,updated_at=1').run();
  s.cancel(receipt); assert.throws(() => s.fencePreparation(receipt), /may already have started/);
  s.close(); assert.equal(f.open().inspect(receipt).phase, 'issued');
});

test('original record, journal generation and binding must match exactly', t => {
  const s = fixture(t).open(), receipt = prepare(s);
  for (const changed of [{ generation: 'different' }, { binding: cliTurnHash('different') }, { requestHash: cliTurnHash('different') }, { nonce: '00000000-0000-4000-8000-000000000000' }]) {
    assert.throws(() => s.issue({ ...receipt, ...changed }), /receipt|binding changed/);
  }
  assert.equal(s.inspect(receipt).phase, 'preparing');
});

test('receipt corruption during insertion rolls back the complete admission', t => {
  const f = fixture(t), s = f.open(), db = f.raw();
  db.exec("CREATE TRIGGER corrupt_receipt AFTER INSERT ON cli_turns BEGIN UPDATE cli_turns SET cancelled=1 WHERE id=NEW.id; END;");
  assert.throws(() => prepare(s), /not saved/); assert.equal(db.prepare('SELECT count(*) AS n FROM cli_turns').get().n, 0);
  db.exec('DROP TRIGGER corrupt_receipt'); assert.equal(s.inspect(prepare(s)).phase, 'preparing');
});

test('failed issue never permits the lifecycle spawn boundary', t => {
  const f = fixture(t), store = f.open(), db = f.raw(), lifecycle = new CliTurnLifecycle(() => ({ store, binding }));
  const scope = lifecycle.begin('codex', 'faulted', { prompt: 'secret' });
  db.exec("CREATE TRIGGER refuse_issue BEFORE UPDATE ON cli_turns WHEN NEW.phase='issued' BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END;");
  let spawns = 0; assert.throws(() => scope.run(() => { lifecycle.assertCanSpawn(); spawns++; }), /storage failure/);
  assert.equal(spawns, 0); assert.equal(db.prepare("SELECT phase FROM cli_turns WHERE id='faulted'").get().phase, 'preparing');
  db.exec('DROP TRIGGER refuse_issue'); scope.close('refused');
});

test('cancel storage failure still fences live callbacks and refuses successful closure', t => {
  const f = fixture(t), store = f.open(), db = f.raw(), lifecycle = new CliTurnLifecycle(() => ({ store, binding }));
  const scope = lifecycle.begin('codex', 'cancel-fault', {}); scope.run(() => lifecycle.assertCanSpawn());
  db.exec("CREATE TRIGGER refuse_cancel BEFORE UPDATE ON cli_turns WHEN NEW.cancelled=1 BEGIN SELECT RAISE(ABORT,'fixture cancel failure'); END;");
  assert.equal(lifecycle.cancel('codex', 'cancel-fault'), true);
  assert.throws(() => scope.run(() => lifecycle.assertCanSpawn()), /cancelled/);
  assert.throws(() => scope.close('done'), /journal failed/);
  assert.equal(db.prepare("SELECT phase FROM cli_turns WHERE id='cancel-fault'").get().phase, 'issued');
});

test('changing the enrollment cannot grant an old callback a new identity', t => {
  const store = fixture(t).open(); let current = binding;
  const lifecycle = new CliTurnLifecycle(() => ({ store, binding: current })), scope = lifecycle.begin('codex', 'original', {});
  current = cliTurnHash('replacement enrollment');
  assert.throws(() => scope.run(() => lifecycle.assertCanSpawn()), /enrollment identity changed/);
  scope.close('refused');
});

test('independent durable cancellation also closes a captured tool authority', t => {
  const f = fixture(t), store = f.open(), lifecycle = new CliTurnLifecycle(() => ({ store, binding }));
  const scope = lifecycle.begin('codex', 'tools', {}); let check;
  scope.run(() => { check = lifecycle.captureToolAuthority(); assert.throws(check, /not started/); lifecycle.assertCanSpawn(); });
  check(); f.raw().prepare("UPDATE cli_turns SET cancelled=1 WHERE id='tools'").run();
  assert.throws(check, /cancelled/); scope.close('error');
});

test('journal schema loss refuses reopening and never silently recreates history', t => {
  const f = fixture(t), s = f.open(); prepare(s); s.close();
  const db = f.raw(); db.exec('DROP TABLE cli_turns');
  assert.throws(() => f.open(), /incomplete/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='cli_turns'").get().n, 0);
});

test('bounded journal refuses new work instead of evicting retained outcomes', t => {
  const s = fixture(t, 1).open(), receipt = prepare(s); s.finish(receipt, 'done');
  assert.throws(() => prepare(s, 'another'), /journal is full/);
  assert.equal(s.inspect(receipt).phase, 'not_started');
});

test('weakened durability refuses issue without silently restoring or accepting it', t => {
  const s = fixture(t).open(), receipt = prepare(s);
  s.db.exec('PRAGMA synchronous=NORMAL');
  assert.throws(() => s.issue(receipt), /FULL WAL/);
  s.db.exec('PRAGMA synchronous=FULL'); assert.equal(s.inspect(receipt).phase, 'preparing');
});

test('failed completion rolls back while retaining the original issued receipt', t => {
  const f = fixture(t), s = f.open(), receipt = prepare(s); s.issue(receipt);
  f.raw().exec("CREATE TRIGGER refuse_finish BEFORE UPDATE ON cli_turns WHEN NEW.phase='uncertain' BEGIN SELECT RAISE(ABORT,'completion write failed'); END;");
  assert.throws(() => s.finish(receipt, 'done'), /completion write failed/);
  assert.deepEqual(s.inspect(receipt), { phase: 'issued', cancelled: false, outcome: null });
});

for (const issued of [false, true]) test(`abrupt process exit preserves ${issued ? 'issued uncertainty' : 'preparation'}`, t => {
  const f = fixture(t); const script = `const {CliTurnJournal}=require(${JSON.stringify(resolve('src/cli-turn-journal.ts'))});const s=new CliTurnJournal(process.argv[1]);const r=s.prepare(process.argv[2],'codex','crashed',{prompt:'private'});${issued ? 's.issue(r);' : ''}console.log(JSON.stringify(r));process.exit(7);`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', script, f.file, binding], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(result.status, 7, result.stderr); const receipt = JSON.parse(result.stdout.trim()), s = f.open();
  assert.equal(s.inspect(receipt).phase, issued ? 'issued' : 'preparing');
  assert.throws(() => prepare(s, 'crashed'), /already admitted/);
  if (issued) assert.throws(() => s.fencePreparation(receipt), /may already have started/); else s.fencePreparation(receipt);
});
