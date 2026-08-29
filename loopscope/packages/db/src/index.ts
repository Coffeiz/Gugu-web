import fs from 'node:fs'
import path from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'

export interface LoopScopeDatabase {
  sqlite: BetterSqlite3.Database
  db: BetterSQLite3Database<typeof schema>
  path: string
}

function columns(sqlite: BetterSqlite3.Database, table: string): Set<string> {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map(row => row.name))
}

function ensureColumn(sqlite: BetterSqlite3.Database, table: string, column: string, ddl: string) {
  if (!columns(sqlite, table).has(column)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
}

export function migrateDatabase(sqlite: BetterSqlite3.Database) {
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_key TEXT PRIMARY KEY,
      external_session_id TEXT,
      source TEXT NOT NULL DEFAULT 'unknown',
      title TEXT NOT NULL DEFAULT 'Untitled session',
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL REFERENCES sessions(session_key) ON DELETE CASCADE,
      trace_id TEXT,
      status TEXT NOT NULL,
      started_at REAL NOT NULL,
      ended_at REAL,
      duration_ms REAL,
      input_json TEXT NOT NULL,
      output_json TEXT NOT NULL,
      attributes_json TEXT NOT NULL,
      usage_json TEXT NOT NULL DEFAULT '{}',
      raw_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runs_session_started ON runs(session_key, started_at DESC);
    CREATE TABLE IF NOT EXISTS spans (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      parent_span_id TEXT,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at REAL NOT NULL,
      ended_at REAL,
      duration_ms REAL,
      input_json TEXT NOT NULL,
      output_json TEXT NOT NULL,
      attributes_json TEXT NOT NULL,
      code_json TEXT NOT NULL DEFAULT '{}',
      usage_json TEXT NOT NULL DEFAULT '{}',
      token_impact_json TEXT NOT NULL DEFAULT '{}',
      ordinal INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_spans_run_ordinal ON spans(run_id, ordinal);
    CREATE INDEX IF NOT EXISTS idx_spans_parent ON spans(run_id, parent_span_id, ordinal);
  `)

  // 0.1/0.2 databases are upgraded in place; no delete/rebuild is required.
  ensureColumn(sqlite, 'runs', 'usage_json', "TEXT NOT NULL DEFAULT '{}'")
  ensureColumn(sqlite, 'spans', 'code_json', "TEXT NOT NULL DEFAULT '{}'")
  ensureColumn(sqlite, 'spans', 'usage_json', "TEXT NOT NULL DEFAULT '{}'")
  ensureColumn(sqlite, 'spans', 'token_impact_json', "TEXT NOT NULL DEFAULT '{}'")
  ensureColumn(sqlite, 'spans', 'code_file', 'TEXT')
  ensureColumn(sqlite, 'spans', 'code_module', 'TEXT')
  ensureColumn(sqlite, 'spans', 'code_function', 'TEXT')
  ensureColumn(sqlite, 'spans', 'code_qualname', 'TEXT')
  ensureColumn(sqlite, 'spans', 'code_line', 'INTEGER')

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_spans_kind ON spans(kind);
    CREATE TABLE IF NOT EXISTS usage (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      span_id TEXT REFERENCES spans(id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read INTEGER,
      cache_write INTEGER,
      fresh_input INTEGER,
      total_tokens INTEGER,
      cache_ratio REAL,
      cost REAL,
      currency TEXT DEFAULT 'USD'
    );
    CREATE INDEX IF NOT EXISTS idx_usage_run ON usage(run_id);
    CREATE INDEX IF NOT EXISTS idx_usage_span ON usage(span_id);
    CREATE TABLE IF NOT EXISTS context_fragments (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      span_id TEXT REFERENCES spans(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      content_markdown TEXT NOT NULL DEFAULT '',
      raw_json TEXT,
      token_count INTEGER,
      source_json TEXT,
      ordinal INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_context_run_ordinal ON context_fragments(run_id, ordinal);
    CREATE INDEX IF NOT EXISTS idx_context_kind ON context_fragments(kind);
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
      span_id TEXT REFERENCES spans(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      source_path TEXT,
      created_at REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifact_hash ON artifacts(content_hash);
    CREATE INDEX IF NOT EXISTS idx_artifact_run ON artifacts(run_id);
  `)
}

export function openDatabase(databasePath: string): LoopScopeDatabase {
  const resolved = path.resolve(databasePath)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  const sqlite = new BetterSqlite3(resolved)
  migrateDatabase(sqlite)
  return { sqlite, db: drizzle(sqlite, { schema }), path: resolved }
}

export * from './schema.js'

