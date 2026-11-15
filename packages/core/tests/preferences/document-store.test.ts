import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { expect, it } from 'vitest'
import { initializeSqlite, migrateSqlite, openSqliteRuntime } from '../../src/data/sqlite.js'
import { createKyselyPreferenceDocumentStore } from '../../src/preferences/document-store.js'

it('正式 SQLite 保存偏好并拒绝其他 owner 写入', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-preference-store-'))
  try {
    const path = join(directory, 'data.db')
    await initializeSqlite(path)
    const opened = await openSqliteRuntime(path)
    try {
      const store = createKyselyPreferenceDocumentStore(opened.runtime.db, 'sqlite')
      expect(await store.read(opened.ownerId)).toBeNull()
      await store.write(opened.ownerId, { palette: 'green', nested: { value: 1 } })
      expect(JSON.parse(String(await store.read(opened.ownerId)))).toEqual({ palette: 'green', nested: { value: 1 } })
      await store.write(opened.ownerId, { palette: 'blue' })
      expect(JSON.parse(String(await store.read(opened.ownerId)))).toEqual({ palette: 'blue' })
      const other = randomUUID()
      expect(await store.read(other)).toBeNull()
      await expect(store.write(other, { palette: 'red' })).rejects.toThrow()
      await expect(sql`UPDATE user_preferences SET user_id=${'f'.repeat(32)}`.execute(opened.runtime.db)).rejects.toThrow()
      expect(JSON.parse(String(await store.read(opened.ownerId)))).toEqual({ palette: 'blue' })
    } finally { await opened.runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('旧版升级保留已有数据和可恢复备份，冲突表不被覆盖', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-preference-upgrade-'))
  try {
    const path = join(directory, 'data.db')
    await initializeSqlite(path)
    const legacy = new Database(path)
    const owner = String((legacy.prepare("SELECT value FROM core_runtime_meta WHERE key='owner_id'").get() as { value: string }).value)
    legacy.prepare('INSERT INTO feedbacks(user_id,username,category,content,created_at) VALUES(?,?,?,?,?)')
      .run(owner.replaceAll('-', ''), '示例用户', 'bug', '保留反馈', '2026-01-01')
    legacy.exec("DROP TABLE user_preferences; UPDATE core_runtime_meta SET value='15' WHERE key='schema_version'")
    legacy.close()
    const backup = await migrateSqlite(path)
    const saved = new Database(backup, { readonly: true })
    try {
      expect(saved.prepare("SELECT value FROM core_runtime_meta WHERE key='schema_version'").get()).toEqual({ value: '15' })
      expect(saved.prepare('SELECT content FROM feedbacks').get()).toEqual({ content: '保留反馈' })
    } finally { saved.close() }
    const opened = await openSqliteRuntime(path)
    try {
      expect(opened.schemaVersion).toBe('17')
      expect((await sql<{ content: string }>`SELECT content FROM feedbacks`.execute(opened.runtime.db)).rows[0]?.content).toBe('保留反馈')
      await createKyselyPreferenceDocumentStore(opened.runtime.db, 'sqlite').write(opened.ownerId, { palette: 'neutral' })
    } finally { await opened.runtime.close() }
    const conflicting = join(directory, 'conflict.db')
    await initializeSqlite(conflicting)
    const old = new Database(conflicting)
    old.exec("DROP TABLE user_preferences; CREATE TABLE user_preferences(old_value TEXT); INSERT INTO user_preferences VALUES ('保留'); UPDATE core_runtime_meta SET value='15' WHERE key='schema_version'")
    old.close()
    await expect(migrateSqlite(conflicting)).rejects.toThrow()
    const intact = new Database(conflicting, { readonly: true })
    try {
      expect(intact.prepare('SELECT old_value FROM user_preferences').get()).toEqual({ old_value: '保留' })
      expect(intact.prepare("SELECT value FROM core_runtime_meta WHERE key='schema_version'").get()).toEqual({ value: '15' })
    } finally { intact.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it.skipIf(!process.env.GUGU_CORE_TEST_POSTGRES_URL)('隔离 PostgreSQL 偏好文档按 owner 读写', async () => {
  const schema = `prefs_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: process.env.GUGU_CORE_TEST_POSTGRES_URL })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const db = new Kysely<{}>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.GUGU_CORE_TEST_POSTGRES_URL, options: `-c search_path=${schema}` }) }) })
  try {
    await sql`CREATE TABLE user_preferences(id serial PRIMARY KEY,user_id uuid NOT NULL UNIQUE,data_json text NOT NULL,updated_at timestamptz NOT NULL)`.execute(db)
    const owner = randomUUID(), other = randomUUID(), store = createKyselyPreferenceDocumentStore(db, 'postgres')
    await store.write(owner, { palette: 'green' })
    await store.write(other, { palette: 'red' })
    await store.write(owner, { palette: 'blue' })
    expect(JSON.parse(String(await store.read(owner)))).toEqual({ palette: 'blue' })
    expect(JSON.parse(String(await store.read(other)))).toEqual({ palette: 'red' })
  } finally { await db.destroy(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
