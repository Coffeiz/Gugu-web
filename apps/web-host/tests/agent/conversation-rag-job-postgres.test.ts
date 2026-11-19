import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { tablesSql } from '@gugu/core/data'
import { enqueueMissingAgentRagBaselines } from '../../../../packages/core/src/agent/rag/rebuild-worker.js'
import { enqueueCalendarRagIndex } from '../../../../packages/core/src/calendar/create-store.js'
import { enqueueMindRagIndex } from '../../../../packages/core/src/mind/rag-index-job.js'
import { createProjectPostCommitPublisher } from '../../src/modules/projects/persistence/project-post-commit-postgres.js'
import { withPostgresTransaction } from '../../src/adapters/database/postgres-transaction.js'
import { enqueuePostgresAgentRagRebuild } from '../../src/modules/agent-sessions/persistence/agent-rag-job-postgres.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const schema = `gugu_conversation_rag_${randomUUID().replaceAll('-', '')}`
let admin: Pool | undefined
let pool: Pool | undefined

after(async () => {
  await pool?.end()
  if (admin) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
  await admin?.end()
})

test('conversation writes coalesce into an owner-wide rebuild and fence an earlier lease', {
  skip: !databaseUrl && '需要显式 GUGU_WEBUI_TEST_DATABASE_URL 运行隔离 PostgreSQL 队列回归',
}, async () => {
  admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  await pool.query(`CREATE TABLE rag_index_jobs (
    id bigserial PRIMARY KEY, user_id uuid NOT NULL, source_type text NOT NULL, source_id text NOT NULL,
    version text NOT NULL, operation text NOT NULL, status text NOT NULL, generation integer NOT NULL,
    completed_generation integer NOT NULL, attempts integer NOT NULL, next_attempt_at timestamptz,
    lease_until timestamptz, last_started_at timestamptz, last_succeeded_at timestamptz,
    last_error_code text, pending_source_ids json NOT NULL, created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL, UNIQUE(user_id, source_type)
  )`)

  const ownerId = randomUUID()
  await withPostgresTransaction(pool, client => enqueuePostgresAgentRagRebuild(client, ownerId, 'conversation'))
  await pool.query(`UPDATE rag_index_jobs SET status='running', generation=2, pending_source_ids='["old-message"]',
    lease_until=CURRENT_TIMESTAMP + interval '1 minute' WHERE user_id=$1 AND source_type='conversation'`, [ownerId])
  await withPostgresTransaction(pool, client => enqueuePostgresAgentRagRebuild(client, ownerId, 'conversation'))

  const row = await pool.query<{ source_id: string; operation: string; generation: number; status: string; lease_until: Date | null; pending_source_ids: string[] }>(
    `SELECT source_id,operation,generation,status,lease_until,pending_source_ids FROM rag_index_jobs WHERE user_id=$1 AND source_type='conversation'`, [ownerId])
  assert.deepEqual(row.rows[0], {
    source_id: '', operation: 'refresh', generation: 3, status: 'queued', lease_until: null, pending_source_ids: [],
  })
})

test('conversation RAG enqueue rolls back with the history transaction', {
  skip: !databaseUrl && '需要显式 GUGU_WEBUI_TEST_DATABASE_URL 运行隔离 PostgreSQL 事务回归',
}, async () => {
  assert.ok(pool)
  const ownerId = randomUUID()
  await assert.rejects(withPostgresTransaction(pool, async client => {
    await enqueuePostgresAgentRagRebuild(client, ownerId, 'conversation')
    throw new Error('synthetic transaction failure')
  }), /synthetic transaction failure/u)
  const row = await pool.query(`SELECT 1 FROM rag_index_jobs WHERE user_id=$1 AND source_type='conversation'`, [ownerId])
  assert.equal(row.rowCount, 0)
})

test('RAG 启动扫描等待未提交的增量任务，冲突后继续建立其他来源基线', {
  skip: !databaseUrl && '需要显式 GUGU_WEBUI_TEST_DATABASE_URL 运行隔离 PostgreSQL 并发回归',
}, async () => {
  assert.ok(pool)
  const owner = randomUUID()
  await pool.query('CREATE TABLE users (id uuid PRIMARY KEY)')
  await pool.query(tablesSql('postgres').ragIndexEntries)
  await pool.query('INSERT INTO users VALUES ($1)', [owner])
  const scanPool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 1 })
  const db = new Kysely({ dialect: new PostgresDialect({ pool: scanPool }) })
  const producer = await pool.connect()
  let scan: Promise<number> | undefined
  try {
    const { rows: [reader] } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db)
    const { rows: [writer] } = await producer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    await producer.query('BEGIN')
    await enqueuePostgresAgentRagRebuild(producer, owner, 'conversation')
    await producer.query("UPDATE rag_index_jobs SET source_id='71', pending_source_ids='[\"71\"]', generation=3 WHERE user_id=$1", [owner])
    scan = enqueueMissingAgentRagBaselines(db, 'postgres', ['conversation', 'calendar'])
    void scan.catch(() => undefined)
    const deadline = Date.now() + 5_000
    while (true) {
      const { rows: [lock] } = await producer.query<{ blocked: boolean }>(
        'SELECT $1::integer = ANY(pg_blocking_pids($2)) AS blocked', [writer!.pid, reader!.pid],
      )
      if (lock!.blocked) break
      assert.ok(Date.now() < deadline, '启动扫描应已通过缺失检查并等待相同唯一键')
      await delay(20)
    }
    await producer.query('COMMIT')
    assert.equal(await scan, 1)
    const { rows } = await producer.query('SELECT source_type, source_id, pending_source_ids, generation FROM rag_index_jobs WHERE user_id=$1 ORDER BY source_type', [owner])
    assert.deepEqual(rows, [
      { source_type: 'calendar', source_id: '', pending_source_ids: [], generation: 1 },
      { source_type: 'conversation', source_id: '71', pending_source_ids: ['71'], generation: 3 },
    ])
  } finally {
    await producer.query('ROLLBACK').finally(() => producer.release())
    await scan?.catch(() => undefined)
    await db.destroy()
  }
})

test('日历、笔记和项目的增量写入保留待执行的全来源重建', {
  skip: !databaseUrl && '需要隔离 PostgreSQL',
}, async () => {
  assert.ok(pool)
  const owner = randomUUID()
  await pool.query('CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY)')
  await pool.query(tablesSql('postgres').ragIndexEntries)
  await pool.query('INSERT INTO users VALUES ($1)', [owner])
  const jobPool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  const db = new Kysely({ dialect: new PostgresDialect({ pool: jobPool }) })
  try {
    await enqueueMissingAgentRagBaselines(db, 'postgres', ['calendar', 'note', 'project'])
    const failures: string[] = []
    const publishProject = createProjectPostCommitPublisher(jobPool, {
      async bumpContextRevision() {},
      async publishResourceChanged() {},
    }, (operation, code) => failures.push(`${operation}: ${code}`))
    const update = async () => {
      await db.transaction().execute(async tx => {
        await enqueueCalendarRagIndex(tx, 'postgres', owner, '71', sql`CURRENT_TIMESTAMP`)
        await enqueueMindRagIndex(tx, 'postgres', owner, 'note', '72', '2026-11-15 00:00:00', 'update')
      })
      await publishProject({ userId: owner, resource: 'projects', entityId: 73, operation: 'update', origin: null })
      assert.deepEqual(failures, [])
    }
    const jobs = () => pool!.query('SELECT source_type, source_id, pending_source_ids, generation, lease_until FROM rag_index_jobs WHERE user_id=$1 ORDER BY source_type', [owner])
    await pool.query("UPDATE rag_index_jobs SET status='running', lease_until=CURRENT_TIMESTAMP + interval '1 minute' WHERE user_id=$1", [owner])
    await update()
    assert.deepEqual((await jobs()).rows, ['calendar', 'note', 'project'].map(source_type => ({
      source_type, source_id: '', pending_source_ids: [], generation: 2, lease_until: null,
    })))
    await pool.query("UPDATE rag_index_jobs SET status='ready', completed_generation=generation WHERE user_id=$1", [owner])
    await update()
    assert.deepEqual((await jobs()).rows, ['calendar', 'note', 'project'].map((source_type, index) => ({
      source_type, source_id: String(71 + index), pending_source_ids: [String(71 + index)], generation: 3, lease_until: null,
    })))
  } finally {
    await db.destroy()
  }
})
