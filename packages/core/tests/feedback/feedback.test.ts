import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { Kysely, PostgresDialect, SqliteDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeSqlite, migrateSqlite, openSqliteRuntime } from '../../src/data/sqlite.js'
import { createFeedbackService, createKyselyFeedbackOperations, FeedbackValidationError } from '../../src/feedback/feedback.js'

const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
it('反馈正文按 Python 空白规则判断并保留 BOM', async () => {
  const saved: string[] = []
  const service = createFeedbackService({
    async submit(_owner, _username, _category, content) { saved.push(content) },
    async list() { return { total: 0, items: [] } },
  })
  await expect(service.submit(randomUUID(), '合成用户', 'bug', '\u001c\u0085')).rejects.toBeInstanceOf(FeedbackValidationError)
  await service.submit(randomUUID(), '合成用户', 'bug', '\u001c内容\u0085')
  await service.submit(randomUUID(), '合成用户', 'bug', '\ufeff内容\ufeff')
  expect(saved).toEqual(['内容', '\ufeff内容\ufeff'])
})
describe.each(['sqlite', 'postgres'] as const)('反馈仓储 %s', (backend) => {
  it.skipIf(backend === 'postgres' && !url)('保存、分类分页与 owner 边界', async () => {
    const schema = `feedback_${randomUUID().replaceAll('-', '')}`
    const admin = backend === 'postgres' ? new Pool({ connectionString: url }) : undefined
    if (admin) await admin.query(`CREATE SCHEMA "${schema}"`)
    const db = backend === 'postgres'
      ? new Kysely<{}>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url, options: `-c search_path=${schema}` }) }) })
      : new Kysely<{}>({ dialect: new SqliteDialect({ database: new Database(':memory:') }) })
    try {
      await sql.raw(`CREATE TABLE feedbacks(id ${backend === 'postgres' ? 'serial' : 'integer'} PRIMARY KEY,user_id ${backend === 'postgres' ? 'uuid' : 'text'},username text NOT NULL,category text NOT NULL,content text NOT NULL,created_at timestamp NOT NULL)`).execute(db)
      const owner = randomUUID(), other = randomUUID()
      const store = createFeedbackService(createKyselyFeedbackOperations(db, backend, owner))
      await expect(store.submit(owner, '合成用户', 'invalid', '内容')).rejects.toBeInstanceOf(FeedbackValidationError)
      await expect(store.submit(owner, '合成用户', 'bug', '  ')).rejects.toBeInstanceOf(FeedbackValidationError)
      await store.submit(owner, '合成用户', 'bug', ' 合成内容 ')
      if (backend === 'postgres') await store.submit(other, '另一用户', 'suggestion', '合成建议')
      else await expect(store.submit(other, '另一用户', 'bug', '不应写入')).rejects.toThrow()
      const page = await store.list(1, 10, 'bug')
      expect(page.total).toBe(1)
      expect(page.items[0]).toMatchObject({ username: '合成用户', category: 'bug', content: '合成内容' })
    } finally {
      await db.destroy()
      if (admin) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
    }
  })
})

it('正式 SQLite 从版本 14 安全升级并限制反馈 owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-feedback-upgrade-'))
  const path = join(dir, 'data.db')
  try {
    await initializeSqlite(path)
    const legacy = new Database(path)
    legacy.exec("DROP TABLE user_preferences; DROP TABLE feedbacks; UPDATE core_runtime_meta SET value='14' WHERE key='schema_version'")
    legacy.close()
    await migrateSqlite(path)
    const opened = await openSqliteRuntime(path)
    try {
      expect(opened.schemaVersion).toBe('16')
      const service = createFeedbackService(createKyselyFeedbackOperations(opened.runtime.db, 'sqlite', opened.ownerId))
      await service.submit(opened.ownerId, '合成用户', 'bug', '反馈')
      expect((await service.list(1, 30, '')).total).toBe(1)
      await expect(service.submit(randomUUID(), '另一用户', 'bug', '反馈')).rejects.toThrow()
      await expect(sql`UPDATE feedbacks SET user_id=${'f'.repeat(32)}`.execute(opened.runtime.db)).rejects.toThrow()
    } finally { await opened.runtime.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
