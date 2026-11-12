import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { createPostgresRuntime } from '../../../src/data/postgres.js'
import { tablesSql } from '../../../src/data/schema.js'
import { dataContract } from '../../fixtures/data-contract.js'

const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
if (!url) throw new Error('PG 契约必须显式提供隔离的 GUGU_CORE_TEST_POSTGRES_URL')
dataContract('隔离 PostgreSQL 的相同项目/联系人契约', async () => {
  const schema = `gugu_core_node_${randomUUID().replaceAll('-', '')}`,
    owner = randomUUID(),
    other = randomUUID()
  const admin = new pg.Client({ connectionString: url })
  await admin.connect()
  let runtime: Awaited<ReturnType<typeof createPostgresRuntime>> | undefined
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    await admin.query(`SET search_path TO ${schema}`)
    const definitions = tablesSql('postgres')
    await admin.query(
      `CREATE TABLE users(id UUID PRIMARY KEY); ${definitions.projects}; ${definitions.clients}; ${definitions.receipts}; ALTER TABLE projects ADD FOREIGN KEY(user_id) REFERENCES users(id); ALTER TABLE clients ADD FOREIGN KEY(user_id) REFERENCES users(id)`,
    )
    await admin.query('INSERT INTO users(id) VALUES($1),($2)', [owner, other])
    runtime = await createPostgresRuntime({
      url: url!,
      schema,
      clock: () => '2026-11-10T10:00:00.123456Z',
    })
    const close = async () => {
      try {
        await runtime?.close()
      } finally {
        if (!/^gugu_core_node_[a-f0-9]{32}$/.test(schema))
          throw new Error('测试 schema 范围无效')
        try {
          await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
        } finally {
          await admin.end()
        }
      }
    }
    return { runtime, owner, other, close }
  } catch (error) {
    await runtime?.close()
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    } finally {
      await admin.end()
    }
    throw error
  }
})
