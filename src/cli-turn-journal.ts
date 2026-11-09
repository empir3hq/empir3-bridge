import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { validNativeStopProof, type CliNativeStopProof } from './cli-job-evidence.js';

// The packaged Bridge runs Node 24. Keep this narrow interface compatible with
// the repository's older @types/node while using Node's bundled SQLite runtime.
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): { get(...args: any[]): any; all(...args: any[]): any[]; run(...args: any[]): { changes: number | bigint } };
  close(): void;
}
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (file: string) => SqliteDatabase };
export type CliJournalPhase = 'preparing' | 'issued' | 'not_started' | 'uncertain' | 'stopped';
export type CliJournalOutcome = 'done' | 'error' | 'refused';
export interface CliTurnReceipt {
  generation: string;
  binding: string;
  provider: string;
  id: string;
  requestHash: string;
  nonce: string;
}
const metaSql = 'CREATE TABLE cli_turn_meta (id INTEGER PRIMARY KEY CHECK(id=1), generation TEXT NOT NULL, version INTEGER NOT NULL CHECK(version=1)) STRICT';
const turnsSql = "CREATE TABLE cli_turns (provider TEXT NOT NULL, id TEXT NOT NULL, binding TEXT NOT NULL, request_hash TEXT NOT NULL, nonce TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('preparing','issued','not_started','uncertain')), cancelled INTEGER NOT NULL CHECK(cancelled IN (0,1)), outcome TEXT CHECK(outcome IN ('done','error','refused')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(provider,id)) STRICT";
const containmentSql = "CREATE TABLE cli_turn_containment (provider TEXT NOT NULL, id TEXT NOT NULL, turn_nonce TEXT NOT NULL, mechanism TEXT NOT NULL CHECK(mechanism='windows-job-v1'), sealed INTEGER NOT NULL CHECK(sealed IN (0,1)), attempt_count INTEGER NOT NULL CHECK(attempt_count BETWEEN 0 AND 32), PRIMARY KEY(provider,id)) STRICT";
const attemptsSql = "CREATE TABLE cli_turn_attempts (provider TEXT NOT NULL, id TEXT NOT NULL, turn_nonce TEXT NOT NULL, attempt_nonce TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('prepared','issued','stopped')), proof_json TEXT, PRIMARY KEY(provider,id,attempt_nonce)) STRICT";
const attemptGuards = [
  { name: 'cli_containment_retained', sql: "CREATE TRIGGER cli_containment_retained BEFORE DELETE ON cli_turn_containment BEGIN SELECT RAISE(ABORT,'CLI containment is retained'); END" },
  { name: 'cli_attempt_retained', sql: "CREATE TRIGGER cli_attempt_retained BEFORE DELETE ON cli_turn_attempts BEGIN SELECT RAISE(ABORT,'CLI attempts are retained'); END" },
  { name: 'cli_containment_binding', sql: `CREATE TRIGGER cli_containment_binding BEFORE UPDATE ON cli_turn_containment
    WHEN NEW.provider IS NOT OLD.provider OR NEW.id IS NOT OLD.id OR NEW.turn_nonce IS NOT OLD.turn_nonce OR NEW.mechanism IS NOT OLD.mechanism
      OR NEW.sealed<OLD.sealed OR NEW.attempt_count<OLD.attempt_count OR (OLD.sealed=1 AND NEW.attempt_count!=OLD.attempt_count)
    BEGIN SELECT RAISE(ABORT,'CLI containment binding changed'); END` },
  { name: 'cli_attempt_binding', sql: `CREATE TRIGGER cli_attempt_binding BEFORE UPDATE ON cli_turn_attempts
    WHEN NEW.provider IS NOT OLD.provider OR NEW.id IS NOT OLD.id OR NEW.turn_nonce IS NOT OLD.turn_nonce OR NEW.attempt_nonce IS NOT OLD.attempt_nonce
      OR NOT ((OLD.phase='prepared' AND NEW.phase='issued' AND NEW.proof_json IS NULL)
        OR (OLD.phase IN ('prepared','issued') AND NEW.phase='stopped' AND NEW.proof_json IS NOT NULL))
    BEGIN SELECT RAISE(ABORT,'CLI attempt binding changed'); END` },
];
const uuid = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const cliTurnHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Durable evidence only. No prompt, credential, tool argument or result is
 * stored here. An issued call remains uncertain even after a normal process
 * result: that result alone does not prove every remote effect has stopped. */
export class CliTurnJournal {
  private readonly db: SqliteDatabase;
  private readonly file: string;
  private readonly identity: { dev: number; ino: number };
  private markerIdentity?: { dev: number; ino: number };
  readonly generation: string;

  constructor(file: string, private readonly maxEntries = 100_000) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw Error('Invalid CLI journal capacity');
    this.file = resolve(file);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    if (!existsSync(this.file) && existsSync(this.file + '.identity')) throw Error('CLI journal history is missing');
    if (!existsSync(this.file)) {
      try { closeSync(openSync(this.file, 'wx', 0o600)); }
      catch (e: any) { if (e?.code !== 'EEXIST') throw e; }
    }
    if (!lstatSync(this.file).isFile() || lstatSync(this.file).isSymbolicLink()) throw Error('Invalid CLI journal file');
    chmodSync(this.file, 0o600);
    this.identity = statSync(this.file);
    this.db = new DatabaseSync(this.file);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      let mayCreateMarker = false;
      this.transaction(() => {
        const entries = this.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        const version = this.db.prepare('PRAGMA user_version').get().user_version;
        if (entries.length === 0 && version === 0) {
          this.db.exec(metaSql); this.db.exec(turnsSql);
          this.db.prepare('INSERT INTO cli_turn_meta VALUES(1,?,1)').run(randomUUID());
          this.db.exec('PRAGMA user_version=1');
          mayCreateMarker = true;
        }
        if (version === 1 || (entries.length === 0 && version === 0)) {
          this.assertSchema(1);
          this.db.exec(containmentSql); this.db.exec(attemptsSql);
          for (const guard of attemptGuards) this.db.exec(guard.sql);
          this.db.exec('PRAGMA user_version=2');
          mayCreateMarker = true;
        }
        this.assertSchema();
      }, false);
      this.generation = this.db.prepare('SELECT generation FROM cli_turn_meta WHERE id=1').get().generation;
      const marker = this.file + '.identity';
      if (!existsSync(marker)) {
        if (!mayCreateMarker && this.db.prepare('SELECT count(*) AS n FROM cli_turns').get().n !== 0) throw Error('CLI journal identity marker is missing');
        try {
          const fd = openSync(marker, 'wx', 0o600);
          try { writeFileSync(fd, this.generation); fsyncSync(fd); } finally { closeSync(fd); }
        } catch (error: any) { if (error?.code !== 'EEXIST') throw error; }
      }
      const markerStat = lstatSync(marker);
      if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size !== 36 || readFileSync(marker, 'utf8') !== this.generation) throw Error('CLI journal identity marker changed');
      this.markerIdentity = markerStat;
    } catch (error) { this.db.close(); throw error; }
  }

  private assertSchema(version = 2): void {
    const entries = this.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    const meta = this.db.prepare('SELECT * FROM cli_turn_meta').all();
    if (entries.length !== (version === 1 ? 2 : 4) || entries.find(r => r.name === 'cli_turn_meta')?.sql !== metaSql
      || entries.find(r => r.name === 'cli_turns')?.sql !== turnsSql
      || (version === 2 && (entries.find(r => r.name === 'cli_turn_containment')?.sql !== containmentSql || entries.find(r => r.name === 'cli_turn_attempts')?.sql !== attemptsSql))
      || this.db.prepare('PRAGMA user_version').get().user_version !== version
      || meta.length !== 1 || meta[0].id !== 1 || meta[0].version !== 1 || !uuid(meta[0].generation)
      || (this.generation && meta[0].generation !== this.generation)) throw Error('CLI journal schema or identity is incomplete');
    if (version === 2) for (const guard of attemptGuards) {
      if (this.db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(guard.name)?.sql !== guard.sql) throw Error('CLI attempt guards are incomplete');
    }
  }

  private transaction<T>(work: () => T, inspect = true): T {
    const stat = lstatSync(this.file);
    if (!stat.isFile() || stat.dev !== this.identity.dev || stat.ino !== this.identity.ino) throw Error('CLI journal file changed');
    if (this.markerIdentity) {
      const marker = lstatSync(this.file + '.identity');
      if (!marker.isFile() || marker.isSymbolicLink() || marker.dev !== this.markerIdentity.dev || marker.ino !== this.markerIdentity.ino
        || marker.size !== 36 || readFileSync(this.file + '.identity', 'utf8') !== this.generation) throw Error('CLI journal identity marker changed');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal'
        || this.db.prepare('PRAGMA synchronous').get().synchronous < 2) throw Error('CLI journal requires FULL WAL');
      if (inspect) this.assertSchema();
      const value = work();
      if (inspect) this.assertSchema();
      this.db.exec('COMMIT');
      return value;
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }

  private row(receipt: CliTurnReceipt): any {
    if (receipt.generation !== this.generation || !hash(receipt.binding) || !hash(receipt.requestHash) || !uuid(receipt.nonce)) throw Error('Invalid CLI execution receipt');
    const row = this.db.prepare('SELECT * FROM cli_turns WHERE provider=? AND id=?').get(receipt.provider, receipt.id);
    if (!row || row.binding !== receipt.binding || row.request_hash !== receipt.requestHash || row.nonce !== receipt.nonce) throw Error('CLI execution binding changed');
    return row;
  }

  prepare(binding: string, provider: string, id: string, payload: unknown, mechanism?: 'windows-job-v1'): Readonly<CliTurnReceipt> {
    if (mechanism !== undefined && mechanism !== 'windows-job-v1') throw Error('Invalid CLI containment mechanism');
    if (!hash(binding) || !['claude', 'codex', 'gemini', 'grok', 'agy'].includes(provider)
      || typeof id !== 'string' || !id || id.length > 200) throw Error('Invalid CLI execution identity');
    const receipt = Object.freeze({ generation: this.generation, binding, provider, id, requestHash: cliTurnHash(payload), nonce: randomUUID() });
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM cli_turns WHERE provider=? AND id=?').get(provider, id)) throw Error('CLI execution identity was already admitted');
      if (this.db.prepare('SELECT count(*) AS count FROM cli_turns').get().count >= this.maxEntries) throw Error('CLI execution journal is full');
      const now = Date.now();
      this.db.prepare("INSERT INTO cli_turns VALUES(?,?,?,?,?,'preparing',0,NULL,?,?)").run(provider, id, binding, receipt.requestHash, receipt.nonce, now, now);
      if (mechanism) this.db.prepare('INSERT INTO cli_turn_containment VALUES(?,?,?,?,0,0)').run(provider, id, receipt.nonce, mechanism);
      const row = this.row(receipt);
      if (row.phase !== 'preparing' || row.cancelled || row.outcome !== null || row.created_at !== now || row.updated_at !== now) throw Error('CLI preparation was not saved');
      if (mechanism && !this.inventory(receipt)) throw Error('CLI containment admission was not saved');
      return receipt;
    });
  }

  issue(receipt: CliTurnReceipt): void {
    this.transaction(() => {
      const before = this.row(receipt);
      if (before.cancelled || !['preparing', 'issued'].includes(before.phase)) throw Error('CLI execution is no longer allowed');
      const now = Date.now();
      this.db.prepare("UPDATE cli_turns SET phase='issued',updated_at=? WHERE provider=? AND id=?").run(now, receipt.provider, receipt.id);
      this.assertRow(receipt, { ...before, phase: 'issued', updated_at: now });
    });
  }

  cancel(receipt: CliTurnReceipt): void {
    this.transaction(() => {
      const before = this.row(receipt), now = Date.now();
      this.db.prepare('UPDATE cli_turns SET cancelled=1,updated_at=? WHERE provider=? AND id=?').run(now, receipt.provider, receipt.id);
      this.assertRow(receipt, { ...before, cancelled: 1, updated_at: now });
    });
  }

  finish(receipt: CliTurnReceipt, outcome: CliJournalOutcome): void {
    this.transaction(() => {
      const before = this.row(receipt);
      if (!['preparing', 'issued'].includes(before.phase)) throw Error('CLI execution already closed');
      const phase = before.phase === 'preparing' ? 'not_started' : 'uncertain', now = Date.now();
      this.db.prepare('UPDATE cli_turns SET phase=?,outcome=?,updated_at=? WHERE provider=? AND id=?').run(phase, outcome, now, receipt.provider, receipt.id);
      this.assertRow(receipt, { ...before, phase, outcome, updated_at: now });
      this.sealInventory(receipt);
    });
  }

  /** Only a preparing record can be safely fenced without a remote outcome.
   * A still-live old creator must commit issue before spawning and loses this
   * race. Neither elapsed time nor process absence permits fencing issued work. */
  fencePreparation(receipt: CliTurnReceipt): void {
    this.transaction(() => {
      const before = this.row(receipt);
      if (before.phase !== 'preparing') throw Error('CLI execution may already have started');
      const now = Date.now();
      this.db.prepare("UPDATE cli_turns SET phase='not_started',cancelled=1,outcome='refused',updated_at=? WHERE provider=? AND id=?").run(now, receipt.provider, receipt.id);
      this.assertRow(receipt, { ...before, phase: 'not_started', cancelled: 1, outcome: 'refused', updated_at: now });
    });
  }

  inspect(receipt: CliTurnReceipt): { phase: CliJournalPhase; cancelled: boolean; outcome: CliJournalOutcome | null } {
    return this.transaction(() => { const row = this.row(receipt); return { phase: row.phase, cancelled: row.cancelled === 1, outcome: row.outcome }; });
  }

  private inventory(receipt: CliTurnReceipt) {
    const meta = this.db.prepare('SELECT * FROM cli_turn_containment WHERE provider=? AND id=?').get(receipt.provider, receipt.id);
    const attempts = this.db.prepare('SELECT * FROM cli_turn_attempts WHERE provider=? AND id=? ORDER BY attempt_nonce').all(receipt.provider, receipt.id);
    if (!meta) { if (attempts.length) throw Error('CLI attempt inventory is incomplete'); return null; }
    if (meta.turn_nonce !== receipt.nonce || meta.mechanism !== 'windows-job-v1' || attempts.length !== meta.attempt_count
      || attempts.some(a => a.turn_nonce !== receipt.nonce || !hash(a.attempt_nonce)
        || (a.phase === 'stopped' ? !a.proof_json : a.proof_json !== null))) throw Error('CLI attempt inventory changed');
    for (const a of attempts) if (a.phase === 'stopped') {
      const proof = JSON.parse(a.proof_json);
      if (!(proof?.mechanism === 'never-issued-v1' && proof.nonce === a.attempt_nonce && meta.sealed === 1)
        && !validNativeStopProof(proof, a.attempt_nonce)) throw Error('CLI stored stop proof changed');
    }
    return { meta, attempts };
  }

  registerAttempt(receipt: CliTurnReceipt): string {
    return this.transaction(() => {
      const turn = this.row(receipt), inventory = this.inventory(receipt);
      if (turn.phase !== 'issued' || turn.cancelled || !inventory || inventory.meta.sealed) throw Error('CLI attempt admission is closed');
      if (inventory.attempts.length >= 32) throw Error('CLI execution attempt limit reached');
      const nonce = randomBytes(32).toString('hex');
      this.db.prepare("INSERT INTO cli_turn_attempts VALUES(?,?,?,?,'prepared',NULL)").run(receipt.provider, receipt.id, receipt.nonce, nonce);
      this.db.prepare('UPDATE cli_turn_containment SET attempt_count=attempt_count+1 WHERE provider=? AND id=?').run(receipt.provider, receipt.id);
      const saved = this.inventory(receipt);
      if (!saved || saved.attempts.length !== inventory.attempts.length + 1 || !saved.attempts.some(a => a.attempt_nonce === nonce && a.phase === 'prepared')) throw Error('CLI attempt preparation was not saved');
      return nonce;
    });
  }

  issueAttempt(receipt: CliTurnReceipt, nonce: string): void {
    this.transaction(() => {
      const turn = this.row(receipt), inventory = this.inventory(receipt);
      if (turn.phase !== 'issued' || turn.cancelled || !inventory || inventory.meta.sealed
        || !inventory.attempts.some(a => a.attempt_nonce === nonce && a.phase === 'prepared')) throw Error('CLI attempt cannot start');
      this.db.prepare("UPDATE cli_turn_attempts SET phase='issued' WHERE provider=? AND id=? AND attempt_nonce=?").run(receipt.provider, receipt.id, nonce);
      if (this.inventory(receipt)?.attempts.find(a => a.attempt_nonce === nonce)?.phase !== 'issued') throw Error('CLI attempt issue was not saved');
    });
  }

  private sealInventory(receipt: CliTurnReceipt): void {
    const inventory = this.inventory(receipt); if (!inventory) return;
    this.db.prepare('UPDATE cli_turn_containment SET sealed=1 WHERE provider=? AND id=?').run(receipt.provider, receipt.id);
    // The same transaction closes admission and fences every never-issued
    // attempt. An old creator must commit issueAttempt before it can spawn.
    for (const a of inventory.attempts) if (a.phase === 'prepared') {
      this.db.prepare("UPDATE cli_turn_attempts SET phase='stopped',proof_json=? WHERE provider=? AND id=? AND attempt_nonce=?")
        .run(JSON.stringify({ mechanism: 'never-issued-v1', nonce: a.attempt_nonce }), receipt.provider, receipt.id, a.attempt_nonce);
    }
    if (this.inventory(receipt)?.meta.sealed !== 1) throw Error('CLI attempt fence was not saved');
  }

  /** Recovery only uses the original request identity. stop closes admission in
   * SQLite before any native cancellation; it never grants a new provider run. */
  recovery(binding: string, provider: string, id: string, requestHash: string, stop = false) {
    if (!hash(binding) || !hash(requestHash) || typeof stop !== 'boolean') throw Error('Invalid CLI recovery identity');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM cli_turns WHERE provider=? AND id=?').get(provider, id);
      if (!row || row.binding !== binding || row.request_hash !== requestHash) throw Error('CLI execution evidence unavailable');
      const receipt = Object.freeze({ generation: this.generation, binding, provider, id, requestHash, nonce: row.nonce });
      this.row(receipt);
      if (stop && ['preparing', 'issued'].includes(row.phase)) {
        const phase = row.phase === 'preparing' ? 'not_started' : 'uncertain';
        this.db.prepare('UPDATE cli_turns SET cancelled=1,phase=?,outcome=?,updated_at=? WHERE provider=? AND id=?')
          .run(phase, 'error', Date.now(), provider, id);
        const saved = this.row(receipt);
        if (saved.cancelled !== 1 || saved.phase !== phase || saved.outcome !== 'error') throw Error('CLI recovery fence was not saved');
      }
      if (stop || !['preparing', 'issued'].includes(row.phase)) this.sealInventory(receipt);
      const inventory = this.inventory(receipt);
      return { receipt, contained: !!inventory, sealed: inventory?.meta.sealed === 1,
        attempts: (inventory?.attempts || []).map(a => ({ nonce: a.attempt_nonce as string, phase: a.phase as 'prepared' | 'issued' | 'stopped' })) };
    });
  }

  recordNativeStop(receipt: CliTurnReceipt, nonce: string, proof: CliNativeStopProof): void {
    if (!validNativeStopProof(proof, nonce)) throw Error('Invalid native CLI stop proof');
    this.transaction(() => {
      this.row(receipt);
      const inventory = this.inventory(receipt), attempt = inventory?.attempts.find(a => a.attempt_nonce === nonce);
      if (!inventory?.meta.sealed || !attempt || !['issued', 'stopped'].includes(attempt.phase)) throw Error('CLI attempt stop is not bound');
      const json = JSON.stringify({ version: proof.version, nonce, mechanism: proof.mechanism, started: proof.started,
        pid: proof.pid, exitCode: proof.exitCode, cancelled: proof.cancelled, timedOut: proof.timedOut, activeProcesses: 0 });
      if (attempt.phase === 'stopped') { if (attempt.proof_json !== json) throw Error('CLI stop proof changed'); return; }
      this.db.prepare("UPDATE cli_turn_attempts SET phase='stopped',proof_json=? WHERE provider=? AND id=? AND attempt_nonce=?")
        .run(json, receipt.provider, receipt.id, nonce);
      if (this.inventory(receipt)?.attempts.find(a => a.attempt_nonce === nonce)?.proof_json !== json) throw Error('CLI stop proof was not saved');
    });
  }

  /** Recover evidence by the original input when the admission reply was lost.
   * Absence is unknown, never proof of non-execution. The only mutation fences
   * preparing work in the same transaction that observes its phase. */
  reconcile(binding: string, provider: string, id: string, requestHash: string, fencePreparation = false) {
    if (!hash(binding) || !hash(requestHash) || !['claude', 'codex', 'gemini', 'grok', 'agy'].includes(provider)
      || typeof id !== 'string' || !id || id.length > 200 || typeof fencePreparation !== 'boolean') throw Error('Invalid CLI reconciliation identity');
    return this.transaction(() => {
      const saved = this.db.prepare('SELECT * FROM cli_turns WHERE provider=? AND id=?').get(provider, id);
      if (!saved || saved.binding !== binding || saved.request_hash !== requestHash) throw Error('CLI execution evidence unavailable');
      const receipt = { generation: this.generation, binding, provider, id, requestHash, nonce: saved.nonce };
      const before = this.row(receipt);
      if (fencePreparation && before.phase === 'preparing') {
        const now = Date.now();
        this.db.prepare("UPDATE cli_turns SET phase='not_started',cancelled=1,outcome='refused',updated_at=? WHERE provider=? AND id=?").run(now, provider, id);
        this.assertRow(receipt, { ...before, phase: 'not_started', cancelled: 1, outcome: 'refused', updated_at: now });
      }
      const row = this.row(receipt);
      const inventory = this.inventory(receipt);
      const stopped = row.phase === 'uncertain' && inventory?.meta.sealed === 1
        && inventory.attempts.every(a => a.phase === 'stopped');
      return Object.freeze({ version: 1 as const, generation: receipt.generation, nonce: receipt.nonce,
        provider, executionId: id, requestHash, phase: (stopped ? 'stopped' : row.phase) as CliJournalPhase,
        ...(stopped ? { termination: { version: 1 as const, mechanism: 'windows-job-v1' as const, attempts: inventory!.meta.attempt_count,
          digest: cliTurnHash({ generation: receipt.generation, nonce: receipt.nonce, attempts: inventory!.attempts.map(a => [a.attempt_nonce, a.proof_json]) }) } } : {}),
        cancelled: row.cancelled === 1, outcome: row.outcome as CliJournalOutcome | null });
    });
  }

  private assertRow(receipt: CliTurnReceipt, expected: any): void {
    if (JSON.stringify(this.row(receipt)) !== JSON.stringify(expected)) throw Error('CLI execution receipt changed during write');
  }

  close(): void { this.db.close(); }
}
