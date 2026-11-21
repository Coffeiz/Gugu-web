import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'vitest'
import { sql } from 'kysely'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { AgentToolEventDetailsNotFoundError, AgentToolEventSessionNotFoundError, createSqlAgentToolEventDetails } from '../../../src/agent/sessions/tool-event-details.js'

test('正式 SQLite schema 读取归属消息、脱敏及数据库侧字符阈值', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gugu-tool-details-')), path = join(dir, 'data.sqlite')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const owner = ownerId.replaceAll('-', '')
      await sql`INSERT INTO conversation_sessions(id,user_id,title,title_locked,summary,source,context_epoch,created_at,updated_at) VALUES (1,${owner},'会话',0,'','web',1,'2026-01-01 00:00:00.000000','2026-01-01 00:00:00.000000')`.execute(runtime.db)
      const insert = async (id: number, timeline: string) => sql`INSERT INTO conversation_messages(id,session_id,conversation_seq,role,content,created_at,display_timeline) VALUES (${id},1,${id},'assistant','','2026-01-01 00:00:00.000000',${timeline})`.execute(runtime.db)
      await insert(1, JSON.stringify([{ kind: 'tool', toolInput: { a: 1 }, toolResult: [{ type: 'image', data: 'synthetic' }] }]))
      const read = createSqlAgentToolEventDetails(runtime.db, 'sqlite')
      assert.deepEqual(await read(ownerId, 1, 1, 0), { toolInput: { a: 1 }, toolResult: [{ type: 'text', text: '[图片已查看]' }] })
      await assert.rejects(read(randomUUID(), 1, 1, 0), AgentToolEventSessionNotFoundError)
      await assert.rejects(read(ownerId, 1, 2, 0), AgentToolEventDetailsNotFoundError)
      await assert.rejects(read(ownerId, 1, 1, 1), AgentToolEventDetailsNotFoundError)
      await insert(2, '{bad')
      await assert.rejects(read(ownerId, 1, 2, 0), /格式无效/)
      const prefix = '[{"kind":"tool","toolResult":"', suffix = '"}]'
      await insert(3, prefix + '中'.repeat(1048576 - prefix.length - suffix.length) + suffix)
      assert.equal(((await read(ownerId, 1, 3, 0)).toolResult as string).length, 1048576 - prefix.length - suffix.length)
      await insert(4, prefix + '中'.repeat(1048577 - prefix.length - suffix.length) + suffix)
      await assert.rejects(read(ownerId, 1, 4, 0), AgentToolEventDetailsNotFoundError)
    } finally { await runtime.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
