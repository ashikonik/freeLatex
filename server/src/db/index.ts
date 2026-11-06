import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

/**
 * Schema DDL, applied on every boot.
 *
 * `CREATE TABLE IF NOT EXISTS` keeps this idempotent, so the server can start
 * against an existing database without a separate migration step. This is the
 * right trade-off for a single-file self-hosted app: no migration history to
 * keep in sync, and a fresh install needs no extra command.
 */
const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY NOT NULL,
  api_key_hash TEXT NOT NULL,
  name         TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'user',
  created_at   INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS users_api_key_hash_idx ON users (api_key_hash);

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY NOT NULL,
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  main_file  TEXT NOT NULL DEFAULT 'main.tex',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS projects_owner_id_idx ON projects (owner_id);

CREATE TABLE IF NOT EXISTS share_tokens (
  id         TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'ro',
  label      TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS share_tokens_token_hash_idx ON share_tokens (token_hash);
CREATE INDEX IF NOT EXISTS share_tokens_project_id_idx ON share_tokens (project_id);

CREATE TABLE IF NOT EXISTS project_snapshots (
  id            TEXT PRIMARY KEY NOT NULL,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  snapshot_data TEXT NOT NULL,
  hash          TEXT NOT NULL,
  created_by    TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS project_snapshots_project_id_idx ON project_snapshots (project_id);
`;

export interface DbHandle {
  db: Db;
  sqlite: Database.Database;
  close: () => void;
}

/**
 * Open the SQLite database and ensure the schema exists.
 *
 * @param dataDir Directory that holds `freelatex.db`. Created if missing.
 * @param filename Database file name, or ':memory:' for an ephemeral database.
 */
export function openDatabase(dataDir: string, filename = 'freelatex.db'): DbHandle {
  const isMemory = filename === ':memory:';
  if (!isMemory) {
    mkdirSync(dirname(join(dataDir, filename)), { recursive: true });
  }

  const sqlite = new Database(isMemory ? filename : join(dataDir, filename));

  // WAL keeps readers from blocking the writer, which matters once the
  // WebSocket sync layer writes while HTTP requests read.
  if (!isMemory) {
    sqlite.pragma('journal_mode = WAL');
  }
  sqlite.pragma('foreign_keys = ON');

  sqlite.exec(SCHEMA_DDL);

  const db = drizzle(sqlite, { schema });

  return {
    db,
    sqlite,
    close: () => sqlite.close(),
  };
}
