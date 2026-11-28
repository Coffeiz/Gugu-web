import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { expect, it } from 'vitest'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { createSqlAgentGroupNames } from '../../../src/agent/sessions/group-names.js'

it('正式 SQLite 群会话昵称按 owner、候选、微秒及 id 排序并校验所有候选时间', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-group-names-')), path = join(dir, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const owner = ownerId.replaceAll('-', ''), stamp = '2026-01-01 00:00:00.000000'
      await sql`INSERT INTO conversation_sessions(id,user_id,title,title_locked,summary,source,chat_type,context_epoch,created_at,updated_at) VALUES
       (1,${owner},'群',0,'','qq','group',1,${stamp},${stamp}),(2,${owner},'私聊',0,'','qq','private',1,${stamp},${stamp}),
       (3,${owner},'缺来源',0,'',NULL,'group',1,${stamp},${stamp}),(4,${owner},'空来源',0,'','','group',1,${stamp},${stamp})`.execute(runtime.db)
      await sql`INSERT INTO conversation_messages(id,session_id,conversation_seq,role,content,platform_user_id,platform_user_name,created_at) VALUES
       (1,1,1,'user','','a','旧','2026-01-01 00:00:00.000001'),
       (2,1,2,'assistant','','a','新','2026-01-01 00:00:00.000002'),
       (3,1,3,'tool','','a','并列','2026-01-01 00:00:00.000002'),
       (4,1,4,'user','','a','','2026-01-01 00:00:00.000003'),
       (5,1,5,'user','','b',' ','2026-01-01 00:00:00.000001'),
       (6,2,1,'user','','a','私聊',${stamp}),(7,3,1,'user','','a','缺来源',${stamp}),(8,4,1,'user','','a','空来源',${stamp})`.execute(runtime.db)
      const lookup = createSqlAgentGroupNames(runtime.db, 'sqlite')
      expect(Object.fromEntries(await lookup(ownerId, 1, ['a','b','missing',...Array.from({length: 1500}, (_, i) => `x${i}`)]))).toEqual({a:'并列',b:' '})
      expect((await lookup(randomUUID(), 1, ['a'])).size).toBe(0)
      expect((await lookup(ownerId, 2, ['a'])).size).toBe(0)
      expect((await lookup(ownerId, 3, ['a'])).size).toBe(0)
      expect((await lookup(ownerId, 4, ['a'])).size).toBe(0)
      expect((await lookup(ownerId, 1, [])).size).toBe(0)
      await sql`UPDATE conversation_messages SET created_at='2026-02-30 00:00:00.000000' WHERE id=1`.execute(runtime.db)
      await expect(lookup(ownerId, 1, ['a'])).rejects.toMatchObject({code:'storage_error',message:'群会话消息时间格式无效'})
      expect(Object.fromEntries(await lookup(ownerId, 1, ['b']))).toEqual({b:' '})
    } finally { await runtime.close() }
  } finally { await rm(dir, {recursive:true,force:true}) }
})
