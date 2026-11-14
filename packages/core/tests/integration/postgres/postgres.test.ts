import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import pg from 'pg'
import { createPostgresRuntime } from '../../../src/data/postgres.js'
import { dataContext } from '../../../src/contracts/index.js'
import { tablesSql } from '../../../src/data/schema.js'

const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
if (!url) throw new Error('PG 契约必须显式提供隔离的 GUGU_CORE_TEST_POSTGRES_URL')
describe('真实 PostgreSQL 的相同业务契约', () => {
  it('微秒/用户外键、跨域回滚、CAS 和持久幂等均保持一致', async () => {
    const schema = `gugu_core_node_${randomUUID().replaceAll('-', '')}`,
      owner = randomUUID(),
      other = randomUUID()
    const admin = new pg.Client({ connectionString: url })
    await admin.connect()
    await admin.query(`CREATE SCHEMA ${schema}`)
    const runtime = await createPostgresRuntime({
      url: url!,
      schema,
      maxConnections: 3,
      clock: () => '2026-11-10T10:00:00.123456Z',
    })
    try {
      await admin.query(`SET search_path TO ${schema}`)
      const definitions = tablesSql('postgres')
      await admin.query(
        `CREATE TABLE users(id UUID PRIMARY KEY); ${definitions.projects}; ${definitions.clients}; ${definitions.receipts}; ALTER TABLE projects ADD FOREIGN KEY(user_id) REFERENCES users(id); ALTER TABLE clients ADD FOREIGN KEY(user_id) REFERENCES users(id)`,
      )
      await admin.query('INSERT INTO users(id) VALUES($1),($2)', [owner, other])
      const context = dataContext(owner)
      await expect(
        runtime.transaction(context, async (data) => {
          await data.projects.create({ name: '需回滚' })
          await data.clients.create({ name: '' })
        }),
      ).rejects.toThrow()
      const project = await runtime.transaction(context, async (data) => {
        expect(await data.projects.list()).toEqual([])
        const project = await data.projects.create({
          name: 'PG 计划',
          client: '小北',
        })
        await data.clients.create({ name: '小北' })
        return project
      })
      expect(project.created_at).toBe('2026-11-10 10:00:00.123456+00:00')
      expect(project.client).toBe('小北')
      await runtime.transaction(dataContext(other), async (data) => {
        expect(await data.projects.list()).toEqual([])
        await expect(
          data.projects.update(project.id, 1, { name: '越权' }),
        ).rejects.toMatchObject({
          code: 'not_found',
        })
      })
      const winners = await Promise.allSettled(
        ['甲', '乙'].map((name) =>
          runtime.transaction(context, (data) =>
            data.projects.update(project.id, 1, { name }),
          ),
        ),
      )
      expect(winners.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
      const operationId = randomUUID(),
        create = () =>
          runtime.operation(
            context,
            operationId,
            'clients.create',
            { name: '仅一次' },
            (data) => data.clients.create({ name: '仅一次' }),
          )
      const receipts = await Promise.all([create(), create()])
      expect(receipts[0]).toEqual(receipts[1])
      expect(await runtime.receipt(dataContext(other), operationId)).toBeNull()
      const result = await sql<{
        seconds: number
      }>`select extract(epoch from current_setting('idle_in_transaction_session_timeout')::interval)::int as seconds`.execute(
        runtime.db,
      )
      expect(result.rows[0]!.seconds).toBe(60)
      await expect(
        runtime.transaction(dataContext(randomUUID()), (data) =>
          data.clients.create({ name: '无效用户' }),
        ),
      ).rejects.toThrow()
    } finally {
      await runtime.close()
      if (!/^gugu_core_node_[a-f0-9]{32}$/.test(schema))
        throw new Error('测试 schema 范围无效')
      await admin.query(`DROP SCHEMA ${schema} CASCADE`)
      await admin.end()
    }
  })
})
