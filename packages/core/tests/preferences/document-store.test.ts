import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { expect, it } from 'vitest'
import { initializeSqlite, openSqliteRuntime } from '../../src/data/sqlite.js'
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
