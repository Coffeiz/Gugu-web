import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect, sql } from 'kysely'
import { expect, it } from 'vitest'
import { agentQueueContract } from '../fixtures/agent-queue-contract.js'
import { initializeSqlite, openSqliteRuntime } from '../../src/data/sqlite.js'
import { createSqlAgentPendingQueue } from '../../src/agent/sessions/pending-queue.js'

agentQueueContract('隔离 SQLite 待发送队列契约', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-core-queue-')), owner = randomUUID(), other = randomUUID()
  const connection = new SQLite(join(dir, 'queue.db'))
  connection.pragma('busy_timeout=5000')
  connection.exec('CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id text); CREATE TABLE conversation_pending_queues(id integer PRIMARY KEY,user_id text,queue_id text,session_id integer,items text,updated_at text,UNIQUE(user_id,queue_id))')
  connection.prepare('INSERT INTO conversation_sessions VALUES (1,?)').run(owner.replaceAll('-', ''))
  const db = new Kysely<any>({ dialect: new SqliteDialect({ database: connection }) })
  return { db, owner, other, async close() { await db.destroy(); await rm(dir, { recursive: true, force: true }) } }
}, 'sqlite')

it('正式 SQLite 损坏队列 JSON 脱敏失败且写事务回滚，合法非数组保持空队列', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-queue-redaction-')), path = join(dir, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const owner = ownerId.replaceAll('-', ''), stamp = '2026-01-01 00:00:00.000000'
      await sql`INSERT INTO conversation_sessions(id,user_id,title,title_locked,summary,source,context_epoch,created_at,updated_at)
        VALUES (1,${owner},'会话',0,'原值','web',1,${stamp},${stamp})`.execute(runtime.db)
      const secret = 'synthetic-secret-queue-value', bad = `{"text":"${secret}`
      await sql`INSERT INTO conversation_pending_queues(user_id,queue_id,session_id,items,updated_at)
        VALUES (${owner},'session-1',1,${bad},${stamp}),(${owner},'import-corrupt',NULL,${bad},${stamp})`.execute(runtime.db)
      await sql`CREATE TRIGGER queue_probe AFTER UPDATE ON conversation_pending_queues BEGIN UPDATE conversation_sessions SET summary='事务内变动' WHERE id=1; END`.execute(runtime.db)
      const queue = createSqlAgentPendingQueue(runtime.db, 'sqlite', {})
      for (const work of [() => queue.readQueue(ownerId, 'session-1'), () => queue.readImportedDrafts(ownerId),
        () => queue.patch(ownerId, 'session-1', 1, [{key:1,text:'新消息'}], [])]) {
        const error = await work().then(() => null, error => error)
        expect(error).toMatchObject({ code: 'storage_error', message: '队列数据格式无效' })
        expect(String(error.stack)).not.toContain(secret)
      }
      expect((await sql<{summary:string}>`SELECT summary FROM conversation_sessions WHERE id=1`.execute(runtime.db)).rows[0]?.summary).toBe('原值')
      expect((await sql<{items:string}>`SELECT items FROM conversation_pending_queues WHERE queue_id='session-1'`.execute(runtime.db)).rows[0]?.items).toBe(bad)
      await sql`UPDATE conversation_pending_queues SET items='{}' WHERE queue_id='session-1'`.execute(runtime.db)
      expect((await queue.readQueue(ownerId, 'session-1'))?.items).toEqual([])
    } finally { await runtime.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
