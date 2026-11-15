import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test } from 'vitest'
import { createPostgresRuntime } from '../../../src/data/postgres.js'
import { check } from './contract.js'
const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
if (!url) throw new Error('PG 回归需要显式隔离 GUGU_CORE_TEST_POSTGRES_URL')
test('隔离 PostgreSQL 与 SQLite 使用相同刷新契约', async () => {
  const schema = `gugu_refresh_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const runtime = await createPostgresRuntime({ url, schema })
  try { await check(runtime, randomUUID(), randomUUID()) } finally { await runtime.close(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
