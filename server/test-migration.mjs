/**
 * Regression test for the schema migration against a LEGACY database
 * (pre-Phase-1: users table without the email/verification/reset columns).
 *
 * Reproduces the production crash: db.js must add the new columns AND create the
 * unique e-mail index without throwing "no such column: email" on an old DB.
 *
 *   Run:  node server/test-migration.mjs   (Node ≥ 22)
 */
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const DB = join(tmpdir(), `imperium-migtest-${Date.now()}.db`);

// 1) Build an OLD-schema DB (as deployed before the account system) with a row.
{
  const old = new DatabaseSync(DB);
  old.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
      password_hash TEXT, salt TEXT, token TEXT,
      is_guest INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE saves (user_id INTEGER PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE leaderboard (user_id INTEGER PRIMARY KEY, name TEXT NOT NULL, valuation REAL NOT NULL, prestige INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
  `);
  old.prepare('INSERT INTO users (username, token, is_guest, created_at) VALUES (?, ?, ?, ?)').run('legacy_user', 'legacy-tok', 0, Date.now());
  old.close();
}

process.env.DB_PATH = DB;
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } };

let dbMod = null;
try { dbMod = await import('./db.js'); ok(true, 'db.js migrates a legacy DB without crashing'); }
catch (e) { fail++; console.error('  ✗ db.js crashed migrating a legacy DB:', e.message); }

if (dbMod) {
  const db = dbMod.default;
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  ok(cols.includes('email'), 'email column added by migration');
  ok(cols.includes('verify_token') && cols.includes('reset_token'), 'verification/reset columns added');
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_users_email'").get();
  ok(!!idx, 'unique e-mail index created (after the column exists)');
  ok(!!dbMod.queries.getUserByName('legacy_user'), 'legacy user data preserved');
}

for (const ext of ['', '-wal', '-shm']) { try { rmSync(DB + ext); } catch {} }
console.log(`\n${fail === 0 ? '✅' : '❌'} migration test: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
