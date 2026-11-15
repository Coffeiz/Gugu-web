import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { sql } from 'kysely'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { createAgentSessionApplication } from '../../../src/agent/sessions/application.js'
import { createSqlAgentSessionRepository } from '../../../src/agent/sessions/data.js'

test('正式 SQLite 会话改名、消息定位和 owner 隔离', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gugu-agent-session-')), path = join(dir, 'core.db')
  try {
    await initializeSqlite(path); const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const owner = ownerId.replaceAll('-', '')
      await sql`INSERT INTO conversation_sessions(id,user_id,title,title_locked,summary,source,context_epoch,created_at,updated_at) VALUES (1,${owner},'旧',0,'','web',1,'2026-01-01 00:00:00.000000','2026-01-01 00:00:00.000000')`.execute(runtime.db)
      await sql`INSERT INTO conversation_messages(id,session_id,conversation_seq,role,content,content_json,created_at) VALUES (1,1,1,'user','',NULL,'2026-01-01 00:00:00.000000'),(2,1,2,'assistant','','[]','2026-01-01 00:00:00.000000'),(3,1,3,'summary','',NULL,'2026-01-01 00:00:00.000000'),(5,1,5,'assistant','','null','2026-01-01 00:00:00.000000')`.execute(runtime.db)
      const app = createAgentSessionApplication(createSqlAgentSessionRepository(runtime.db, 'sqlite'))
      assert.deepEqual(await app.rename(ownerId, 1, `  ${'😀'.repeat(300)}  `), { id: 1, title: '😀'.repeat(300), title_locked: true })
      await assert.rejects(app.rename(ownerId, 1, '😀'.repeat(301)), /标题过长/)
      await assert.rejects(app.rename(ownerId, 1, '  '), /标题不能为空/)
      assert.equal(await app.rename(randomUUID(), 1, '越权'), null)
      assert.deepEqual(await app.locate(ownerId, 1), { id: 1, sessionId: 1 })
      assert.equal(await app.locate(randomUUID(), 1), null)
      for (const id of [2, 3, 4, 5]) assert.equal(await app.locate(ownerId, id), null)
    } finally { await runtime.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('隔离缺表库明确要求升级', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gugu-agent-session-missing-')), path = join(dir, 'core.db')
  try {
    await initializeSqlite(path); const { runtime } = await openSqliteRuntime(path)
    try {
      await sql`DROP TABLE conversation_messages`.execute(runtime.db)
      const app = createAgentSessionApplication(createSqlAgentSessionRepository(runtime.db, 'sqlite'))
      await assert.rejects(app.locate(randomUUID(), 1), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'schema_upgrade_required')
    } finally { await runtime.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
