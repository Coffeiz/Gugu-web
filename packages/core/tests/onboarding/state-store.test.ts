import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { Kysely, PostgresDialect, SqliteDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeSqlite, migrateSqlite, openSqliteRuntime } from '../../src/data/sqlite.js'
import { createKyselyOnboardingStore } from '../../src/onboarding/store.js'
import { createOnboardingService } from '../../src/onboarding/service.js'

const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
describe.each(['sqlite', 'postgres'] as const)('引导状态仓储 %s', (backend) => {
  it.skipIf(backend === 'postgres' && !url)('保留旧播种数据并隔离 owner，更新无丢失', async () => {
    const schema = `onboarding_${randomUUID().replaceAll('-', '')}`
    const admin = backend === 'postgres' ? new Pool({ connectionString: url }) : undefined
    if (admin) await admin.query(`CREATE SCHEMA "${schema}"`)
    const db = backend === 'postgres'
      ? new Kysely<{}>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url, options: `-c search_path=${schema}` }) }) })
      : new Kysely<{}>({ dialect: new SqliteDialect({ database: new Database(':memory:') }) })
    try {
      await sql.raw(`CREATE TABLE onboarding_state(user_id ${backend === 'postgres' ? 'uuid' : 'text'} PRIMARY KEY,state ${backend === 'postgres' ? 'json' : 'text'},created_at timestamp,updated_at timestamp)`).execute(db)
      const owner = randomUUID(), other = randomUUID()
      const key = backend === 'sqlite' ? owner.replaceAll('-', '') : owner
      const old = JSON.stringify({ seeded: true, seeded_project_id: 41 })
      if (backend === 'postgres') await sql`INSERT INTO onboarding_state(user_id,state) VALUES(${key},${old}::json)`.execute(db)
      else await sql`INSERT INTO onboarding_state(user_id,state) VALUES(${key},${old})`.execute(db)
      const store = createKyselyOnboardingStore(db, backend)
      const service = createOnboardingService(store)
      expect((await service.get(owner)).seed).toMatchObject({ seeded: true, project_id: 41 })
      await service.update(owner, { completed_steps: ['locale', 'locale'], dismissed: true })
      const result = await service.reopen(owner)
      expect(result.seed).toMatchObject({ seeded: true, project_id: 41 })
      expect(result.guide).toMatchObject({ completed_steps: ['locale'], dismissed: false })
      await expect(service.update(owner, { current_step: 'invalid' })).rejects.toThrow()
      expect((await service.get(other)).seed).toMatchObject({ seeded: false })
    } finally {
      await db.destroy()
      if (admin) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
    }
  })
})

it('正式 SQLite 版本 13 升级保留数据并约束引导状态 owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-onboarding-upgrade-'))
  const path = join(dir, 'data.db')
  try {
    await initializeSqlite(path)
    const legacy = new Database(path)
    legacy.exec("DROP TABLE user_preferences; DROP TABLE feedbacks; DROP TABLE onboarding_state; UPDATE core_runtime_meta SET value='13' WHERE key='schema_version'")
    legacy.close()
    await migrateSqlite(path)
    const opened = await openSqliteRuntime(path)
    try {
      expect(opened.schemaVersion).toBe('17')
      const store = createKyselyOnboardingStore(opened.runtime.db, 'sqlite')
      await store.updateGuide(opened.ownerId, { current_step: 'model' })
      expect((await store.getState(opened.ownerId)).guide).toMatchObject({ current_step: 'model' })
      await expect(store.getState(randomUUID())).rejects.toThrow()
      await expect(sql`UPDATE onboarding_state SET state=NULL`.execute(opened.runtime.db)).rejects.toThrow()
    } finally { await opened.runtime.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('正式 SQLite 版本 12 连续升级创建 SMTP 和引导状态', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-onboarding-upgrade-'))
  const path = join(dir, 'data.db')
  try {
    await initializeSqlite(path)
    const legacy = new Database(path)
    legacy.exec("DROP TABLE user_preferences; DROP TABLE feedbacks; DROP TABLE onboarding_state; DROP TABLE user_smtp_configs; UPDATE core_runtime_meta SET value='12' WHERE key='schema_version'")
    legacy.close()
    await migrateSqlite(path)
    const opened = await openSqliteRuntime(path)
    try {
      expect(opened.schemaVersion).toBe('17')
      const store = createKyselyOnboardingStore(opened.runtime.db, 'sqlite')
      expect((await store.getState(opened.ownerId)).seed).toMatchObject({ seeded: false })
      expect((await sql`SELECT count(*) AS total FROM user_smtp_configs`.execute(opened.runtime.db)).rows).toHaveLength(1)
    } finally { await opened.runtime.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('版本 13 已有冲突表时拒绝升级并保留原内容', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-onboarding-conflict-'))
  const path = join(dir, 'data.db')
  try {
    await initializeSqlite(path)
    const legacy = new Database(path)
    legacy.exec("DROP TABLE user_preferences; DROP TABLE feedbacks; DROP TABLE onboarding_state; CREATE TABLE onboarding_state(old_value TEXT); INSERT INTO onboarding_state VALUES ('保留'); UPDATE core_runtime_meta SET value='13' WHERE key='schema_version'")
    legacy.close()
    await expect(migrateSqlite(path)).rejects.toThrow()
    const result = new Database(path, { readonly: true })
    try {
      expect(result.prepare('SELECT old_value FROM onboarding_state').pluck().get()).toBe('保留')
      expect(result.prepare("SELECT value FROM core_runtime_meta WHERE key='schema_version'").pluck().get()).toBe('13')
    } finally { result.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
