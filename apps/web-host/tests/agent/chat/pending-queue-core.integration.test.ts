import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { test } from 'node:test'
import { Pool } from 'pg'
import { createSqlAgentPendingQueue, QueueConflict, QueueSessionNotFound } from '@gugu/core/agent-sessions'

const require = createRequire(new URL('../../../../../packages/core/package.json', import.meta.url))
const { Kysely, SqliteDialect, PostgresDialect } = require('kysely')
const SQLite = require('better-sqlite3')
const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

for (const dialect of ['sqlite', 'postgres'] as const) test(`${dialect} 共享待发送队列事务、并发认领及用户隔离`, { skip: dialect === 'postgres' && !url ? '需要隔离 PostgreSQL' : false }, async () => {
  const owner = randomUUID(), other = randomUUID(), tmp = await mkdtemp(join(tmpdir(), 'gugu-queue-'))
  let db: any, admin: Pool | undefined, schema = ''
  try {
    if (dialect === 'sqlite') {
      const connection = new SQLite(join(tmp, 'queue.db'))
      connection.pragma('busy_timeout=5000')
      connection.exec('CREATE TABLE conversation_sessions(id INTEGER PRIMARY KEY,user_id TEXT); CREATE TABLE conversation_pending_queues(id INTEGER PRIMARY KEY,user_id TEXT,queue_id TEXT,session_id INTEGER,items TEXT,updated_at TEXT, UNIQUE(user_id,queue_id));')
      connection.prepare('INSERT INTO conversation_sessions VALUES (?,?)').run(1, owner.replaceAll('-', ''))
      db = new Kysely({ dialect: new SqliteDialect({ database: connection }) })
    } else {
      admin = new Pool({ connectionString: url }); schema = `queue_${randomUUID().replaceAll('-', '')}`
      await admin.query(`CREATE SCHEMA "${schema}"`)
      const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
      await pool.query('CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid); CREATE TABLE conversation_pending_queues(id bigserial PRIMARY KEY,user_id uuid,queue_id text,session_id integer,items jsonb,updated_at timestamptz, UNIQUE(user_id,queue_id))')
      await pool.query('INSERT INTO conversation_sessions VALUES (1,$1)', [owner])
      db = new Kysely({ dialect: new PostgresDialect({ pool }) })
    }
    let time = 100, serial = 0, active = false, clock = '2026-01-01T12:00:00.100Z'
    const service = createSqlAgentPendingQueue(db, dialect, { isSessionActive: async () => active, nowSeconds: () => time, createToken: () => `claim-${++serial}`, clock: () => clock })
    await service.replaceDraft(owner, 'import-draft', [{ key: 7, text: '草稿' }])
    await service.replaceDraft(owner, 'import-safe', [{ key: 9, text: '附件', attachments: [{ name: '合成', unexpected: '不得保存' }] }])
    const sanitized = await service.readQueue(owner, 'import-safe')
    assert.deepEqual(sanitized?.items, [{ key: 9, text: '附件', attachments: [{ name: '合成' }], references: [], queue_id: 'import-safe', session_id: null, claimed: false }])
    await service.replaceDraft(owner, 'import-safe', [])
    assert.equal((await service.readImportedDrafts(owner)).length, 1); assert.equal((await service.readImportedDrafts(other)).length, 0)
    if (dialect === 'sqlite') {
      clock = '2026-01-01T12:00:00.200Z'; await service.replaceDraft(owner, 'import-second', [{ key: 8, text: '草稿' }])
      clock = '2026-01-01T12:00:00.300Z'; await service.replaceDraft(owner, 'import-draft', [{ key: 7, text: '更新' }])
      assert.deepEqual((await service.readImportedDrafts(owner)).map(value => value.queueId), ['import-second', 'import-draft'])
    }
    await service.patch(owner, 'session-1', 1, [{ key: 1, text: '第一项' }, { key: 2, text: '第二项' }], [])
    assert.throws(() => service.replaceDraft(owner, 'session-1', []), QueueConflict)
    await assert.rejects(service.readQueue('not-an-owner', 'session-1'))
    if (dialect === 'sqlite') {
      const workerCode = `const { parentPort, workerData } = require('node:worker_threads');
        const { Kysely, SqliteDialect } = require(workerData.kysely); const SQLite = require(workerData.sqlite);
        (async () => { const connection = new SQLite(workerData.path); connection.pragma('busy_timeout=5000');
          const db = new Kysely({ dialect: new SqliteDialect({ database: connection }) });
          try { const { createSqlAgentPendingQueue } = await import(workerData.entry);
            const queue = createSqlAgentPendingQueue(db, 'sqlite', { isSessionActive: async () => false });
            parentPort.postMessage(await queue.claim(workerData.owner, 1, 'session-1', 2));
          } finally { await db.destroy() } })().catch(error => { throw error });`
      const claimInWorker = () => new Promise<{ claimToken: string | null }>((resolve, reject) => {
        const worker = new Worker(workerCode, { eval: true, workerData: { kysely: require.resolve('kysely'), sqlite: require.resolve('better-sqlite3'), entry: import.meta.resolve('@gugu/core/agent-sessions'), path: join(tmp, 'queue.db'), owner } })
        worker.once('message', resolve); worker.once('error', reject)
      })
      const concurrent = await Promise.all([claimInWorker(), claimInWorker()])
      assert.equal(concurrent.filter(value => value.claimToken).length, 1)
    }
    await assert.rejects(service.patch(other, 'session-1', 1, [], []), QueueSessionNotFound)
    await assert.rejects(service.patch(owner, 'session-2', 1, [], []), QueueConflict)
    active = true; assert.equal((await service.claim(owner, 1, 'session-1', 1)).reason, 'session_active'); active = false
    const claims = await Promise.all([service.claim(owner, 1, 'session-1', 1), service.claim(owner, 1, 'session-1', 1)])
    assert.equal(claims.filter(value => value.claimToken).length, 1)
    const first = claims.find(value => value.claimToken)!.claimToken!
    await service.patch(owner, 'session-1', 1, [{ key: 1, text: '已编辑' }], [2])
    const current = await service.readQueue(owner, 'session-1')
    assert.equal(current?.items[0]?.claimed, true)
    assert.equal(JSON.stringify(current).includes(first), false)
    assert.equal(JSON.stringify(current).includes('_claim_until'), false)
    assert.equal(await service.release(owner, 1, 'session-1', 1, 'wrong'), false)
    time += 61
    const renewed = await service.claim(owner, 1, 'session-1', 1)
    assert.ok(renewed.claimToken); assert.equal(await service.release(owner, 1, 'session-1', 1, first), false)
    assert.equal(await service.release(owner, 1, 'session-1', 1, renewed.claimToken!), true)
    assert.equal(await service.readQueue(other, 'session-1'), null)
  } finally { await db?.destroy(); if (admin) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() } await rm(tmp, { recursive: true, force: true }) }
})
