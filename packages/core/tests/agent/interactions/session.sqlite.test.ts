import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { expect, it } from 'vitest'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { createSqlAgentInteractionSession, InteractionNotFoundError } from '../../../src/agent/sessions/interaction-session.js'

it('正式 SQLite 凭据深链保持 owner、Python 真值、单次 JSON 解码与只读语义', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-prompt-')), path = join(dir, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const owner = ownerId.replaceAll('-', ''), date = '2026-01-01 00:00:00.000000'
      await sql`INSERT INTO conversation_sessions(id,user_id,title,title_locked,summary,source,context_epoch,created_at,updated_at) VALUES (1,${owner},'对话',0,'','web',1,${date},${date})`.execute(runtime.db)
      const valid = { secret_fields: [{ name: 'synthetic-secret' }], context: { secret_target: { kind: 'mcp_credentials', hidden: 'synthetic-private' } } }
      for (const [id, value, status] of [[1, valid, 'expired'], [2, { ...valid, secret_fields: [] }, 'active'], [3, JSON.stringify(valid), 'resolved'], [4, { ...valid, secret_fields: { field: true } }, 'resolved']] as const) {
        await sql`INSERT INTO interaction_prompts(id,user_id,session_id,kind,title,body,schema_json,status,expires_at,created_at) VALUES (${id},${owner},1,'confirm','','',${JSON.stringify(value)},${status},${date},${date})`.execute(runtime.db)
      }
      const lookup = createSqlAgentInteractionSession(runtime.db, 'sqlite')
      expect(await lookup(ownerId, 1)).toEqual({ session_id: 1 })
      expect(await lookup(ownerId, 4)).toEqual({ session_id: 1 })
      for (const id of [2, 3, 999]) await expect(lookup(ownerId, id)).rejects.toBeInstanceOf(InteractionNotFoundError)
      await expect(lookup(randomUUID(), 1)).rejects.toBeInstanceOf(InteractionNotFoundError)
      await sql`UPDATE interaction_prompts SET schema_json=${'{"synthetic-secret":"破损'} WHERE id=1`.execute(runtime.db)
      await expect(lookup(ownerId, 1)).rejects.toMatchObject({ code: 'storage_error', message: '交互数据格式无效' })
    } finally { await runtime.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
