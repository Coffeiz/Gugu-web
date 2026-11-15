import { test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect, sql } from 'kysely'
import pg from 'pg'
import type { MindDatabase } from '../../../src/mind/note-postgres-sqlite.js'
import { tablesSql } from '../../../src/data/schema.js'
import { contract } from '../../fixtures/mind-note-contract.js'

const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
if (!url) throw new Error('PG 契约必须显式提供隔离的 GUGU_CORE_TEST_POSTGRES_URL')
test('PostgreSQL 便签与 Undo 共同提交并在 Undo 失败时回滚', async () => {
  const admin = new pg.Pool({ connectionString: url })
  const schema = `gugu_mind_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema} -c timezone=UTC` })
  const db = new Kysely<MindDatabase>({ dialect: new PostgresDialect({ pool }) })
  try {
    await sql.raw(tablesSql('postgres').mindNodes).execute(db)
    await sql.raw(tablesSql('postgres').undo).execute(db)
    await contract(db, 'postgres')
  } finally { await db.destroy(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
