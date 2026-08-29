import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import BetterSqlite3 from 'better-sqlite3'
import { openDatabase } from './index.js'

function withTempDatabase(run: (databasePath: string) => void) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loopscope-db-'))
  const databasePath = path.join(directory, 'loopscope.db')
  try {
    run(databasePath)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('新数据库会建立完整的 LoopScope schema', () => {
  withTempDatabase(databasePath => {
    const database = openDatabase(databasePath)
    const tables = database.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>

    assert.deepEqual(
      tables.map(table => table.name),
      ['artifacts', 'context_fragments', 'runs', 'sessions', 'spans', 'usage'],
    )
    assert.equal(database.sqlite.pragma('foreign_keys', { simple: true }), 1)
    database.sqlite.close()
  })
})

test('旧数据库缺少新增列时会原地迁移并可重复打开', () => {
  withTempDatabase(databasePath => {
    const sqlite = new BetterSqlite3(databasePath)
    sqlite.exec(`
      CREATE TABLE sessions (
        session_key TEXT PRIMARY KEY,
        external_session_id TEXT,
        source TEXT NOT NULL DEFAULT 'unknown',
        title TEXT NOT NULL DEFAULT 'Untitled session',
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        trace_id TEXT,
        status TEXT NOT NULL,
        started_at REAL NOT NULL,
        ended_at REAL,
        duration_ms REAL,
        input_json TEXT NOT NULL,
        output_json TEXT NOT NULL,
        attributes_json TEXT NOT NULL,
        raw_json TEXT NOT NULL
      );
      CREATE TABLE spans (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
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
        ordinal INTEGER NOT NULL
      );
    `)
    sqlite.close()

    const database = openDatabase(databasePath)
    const columns = database.sqlite
      .prepare('PRAGMA table_info(spans)')
      .all() as Array<{ name: string }>
    assert.ok(columns.some(column => column.name === 'token_impact_json'))
    assert.ok(columns.some(column => column.name === 'code_line'))
    database.sqlite.close()

    const reopened = openDatabase(databasePath)
    assert.ok(reopened.sqlite)
    reopened.sqlite.close()
  })
})
