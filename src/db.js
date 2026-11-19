import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export function openDb(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'corral.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      client TEXT,
      token_id INTEGER,
      ip TEXT,
      endpoint TEXT,
      model TEXT,
      stream INTEGER,
      status INTEGER,
      prompt_tokens INTEGER,
      output_tokens INTEGER,
      approx INTEGER DEFAULT 0,
      ttft_ms INTEGER,
      total_ms INTEGER,
      load_ms INTEGER,
      tps REAL,
      ctx_limit INTEGER,
      overflow INTEGER DEFAULT 0,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);

    CREATE TABLE IF NOT EXISTS ps_samples (
      ts INTEGER NOT NULL,
      model TEXT,
      size INTEGER,
      size_vram INTEGER,
      context_length INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_ps_ts ON ps_samples(ts);

    CREATE TABLE IF NOT EXISTS tokens (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      hash TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS remotes (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      admin_token TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      emoji TEXT,
      description TEXT,
      system TEXT,
      model TEXT,
      params TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  return db;
}

export const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

export function createToken(db, name) {
  const token = 'crl_' + crypto.randomBytes(16).toString('hex');
  const info = db
    .prepare('INSERT INTO tokens (name, hash, prefix, created_at) VALUES (?, ?, ?, ?)')
    .run(name, hashToken(token), token.slice(0, 8), Date.now());
  return { id: Number(info.lastInsertRowid), name, token };
}

export function findToken(db, token) {
  if (!token || !token.startsWith('crl_')) return null;
  return db.prepare('SELECT * FROM tokens WHERE hash = ? AND revoked_at IS NULL').get(hashToken(token)) || null;
}

export function kvGet(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}
export function kvSet(db, key, value) {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value)
  );
}
