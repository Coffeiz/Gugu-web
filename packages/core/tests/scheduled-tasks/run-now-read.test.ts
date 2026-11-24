import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { databaseTime } from '../../src/data/codec.js'
import { initializeSqlite, openSqliteRuntime } from '../../src/data/sqlite.js'
import type { SqlDataRuntime } from '../../src/data/runtime.js'
import { createKyselyScheduledTaskExecutionReader, createKyselyScheduledTaskRunNowReader } from '../../src/scheduled-tasks/run-now-read.js'
import { createSqlImPushWriter } from '../../src/agent/sessions/im-push.js'
import { createSqlConversationHistoryTrimmer } from '../../src/agent/sessions/retention.js'

let directory: string
let runtime: SqlDataRuntime
let owner: string
let other: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'gugu-task-run-now-'))
  const path = join(directory, 'core.db')
  await initializeSqlite(path)
  const opened = await openSqliteRuntime(path)
  runtime = opened.runtime
  owner = opened.ownerId
  other = randomUUID()
  const storedOwner = owner.replaceAll('-', '')
  const time = databaseTime('2026-01-01T12:34:56.123456Z', 'sqlite')
  await sql`INSERT INTO scheduled_tasks(id,user_id,name,payload,cron,schedule_kind,start_at,end_at,channels,enabled,last_run_failed,created_at,updated_at)
    VALUES(42,${storedOwner},'合成任务','做一件事','*','cron',${time},${time},'web',1,0,${time},${time})`.execute(runtime.db)
  await sql`INSERT INTO scheduled_tasks(id,user_id,name,payload,cron,schedule_kind,start_at,end_at,channels,enabled,last_run_failed,created_at,updated_at)
    VALUES(43,${storedOwner},'失败一次性任务','做一件事','@once','once',${time},NULL,'web',1,1,${time},${time})`.execute(runtime.db)
  await sql`INSERT INTO scheduled_tasks(id,user_id,name,payload,cron,schedule_kind,channels,enabled,created_at,updated_at)
    VALUES(44,${other.replaceAll('-', '')},'异主任务','','*','cron','web',1,${time},${time})`.execute(runtime.db)
})

afterEach(async () => {
  await runtime?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

it('定时推送在正式 SQLite 会话中分离群与私聊，写入失败回滚消息序号', async () => {
  const write = createSqlImPushWriter(runtime.db, 'sqlite', () => '2026-01-01T12:00:00Z')
  const payload = { ownerId: owner, title: '合成提醒', text: '测试正文', boundSessionId: null }
  const group = { platform: 'qq' as const, botId: '7', chatType: 'group' as const, recipient: 'synthetic-peer' }
  const groupSession = await write({ ...payload, peer: group })
  const privateSession = await write({ ...payload, boundSessionId: groupSession, peer: { ...group, chatType: 'c2c' } })
  expect(privateSession).not.toBe(groupSession)
  await sql`CREATE TRIGGER deny_failed_push BEFORE INSERT ON conversation_messages
    WHEN NEW.content LIKE '%合成写入失败%' BEGIN SELECT RAISE(ABORT,'合成写入失败'); END`.execute(runtime.db)
  await expect(write({ ...payload, peer: group, text: '合成写入失败' })).rejects.toThrow()
  expect(await write({ ...payload, peer: group, boundSessionId: privateSession })).toBe(groupSession)
  const { rows } = await sql`
    SELECT s.chat_type,s.last_message_seq,m.conversation_seq,m.content
    FROM conversation_sessions s JOIN conversation_messages m ON m.session_id=s.id
    ORDER BY s.id,m.conversation_seq`.execute(runtime.db)
  expect(rows).toEqual([
    { chat_type: 'group', last_message_seq: 2, conversation_seq: 1, content: '⏰ 合成提醒\n\n测试正文' },
    { chat_type: 'group', last_message_seq: 2, conversation_seq: 2, content: '⏰ 合成提醒\n\n测试正文' },
    { chat_type: 'c2c', last_message_seq: 1, conversation_seq: 1, content: '⏰ 合成提醒\n\n测试正文' },
  ])
})

it('裁剪按摘要水位和锚点顺序保留最新消息，并跳过异主、在途会话和待处理消息', async () => {
  const write = createSqlImPushWriter(runtime.db, 'sqlite')
  const id = await write({ ownerId: owner, boundSessionId: null, title: '合成提醒', text: '正文',
    peer: { platform: 'wechat', botId: '7', chatType: 'c2c', recipient: 'synthetic-peer' } })
  const trim = createSqlConversationHistoryTrimmer(runtime.db, 'sqlite')
  const count = async () => (await sql<{ count: number }>`SELECT count(*) AS count
    FROM conversation_messages WHERE session_id=${id}`.execute(runtime.db)).rows[0]!.count
  const timestamp = '2026-01-01 00:00:00.000000'
  await sql`INSERT INTO conversation_messages (session_id,conversation_seq,role,content,created_at)
    WITH RECURSIVE series(seq) AS (SELECT 2 UNION ALL SELECT seq+1 FROM series WHERE seq<2004)
    SELECT ${id},seq,'user','合成历史',${timestamp} FROM series`.execute(runtime.db)
  await sql`UPDATE conversation_messages SET run_id='im-pending:synthetic' WHERE session_id=${id} AND conversation_seq=1`.execute(runtime.db)
  await sql`UPDATE conversation_messages SET history_anchor_seq=CASE WHEN conversation_seq=2 THEN 2500 ELSE 1 END
    WHERE session_id=${id} AND conversation_seq IN (2,4)`.execute(runtime.db)
  await sql`UPDATE conversation_sessions SET baseline_message_seq=100 WHERE id=${id}`.execute(runtime.db)
  await trim(owner, id)
  expect(await count()).toBe(2004)
  await sql`UPDATE conversation_messages SET role='summary',covers_until_seq=3 WHERE session_id=${id} AND conversation_seq=2004`.execute(runtime.db)
  await trim(other, id)
  expect(await count()).toBe(2004)
  await sql`UPDATE conversation_sessions SET execution_state='running' WHERE id=${id}`.execute(runtime.db)
  await trim(owner, id)
  expect(await count()).toBe(2004)
  await sql`UPDATE conversation_sessions SET execution_state='idle' WHERE id=${id}`.execute(runtime.db)
  await trim(owner, id)
  await trim(owner, id)
  const remaining = (await sql<{ conversation_seq: number }>`SELECT conversation_seq FROM conversation_messages WHERE session_id=${id}
    AND (conversation_seq<=5 OR role='summary') ORDER BY conversation_seq`.execute(runtime.db)).rows
  expect(remaining.map(row => row.conversation_seq)).toEqual([1, 2, 5, 2004])
  expect(await count()).toBe(2002)
})

describe('一次运行任务的 Core owner 读取合同', () => {
  it('执行快照只读取 owner 的活动目标，保留工具和附件配置且拒绝旧 im 多群', async () => {
    const qq = { chat_type: 'group', chat_id: 'synthetic-qq', channel_id: '1' }
    const feishu = { chat_type: 'group', chat_id: 'synthetic-feishu', channel_id: '2' }
    await runtime.db.updateTable('scheduled_tasks').set({
      channels: 'qq,email', delivery_targets: JSON.stringify({ qq, feishu }),
      authorized_tools: JSON.stringify(['send_email']), email_attachment_file_paths: JSON.stringify([17]),
    }).where('id', '=', 43).execute()
    const read = createKyselyScheduledTaskExecutionReader(runtime.db, 'sqlite')
    expect(await read(owner, '43')).toMatchObject({ plan: {
      ownerId: owner, id: '43', payload: '做一件事', channels: ['qq', 'email'], deliveryTargets: { qq },
      authorizedTools: ['send_email'], emailAttachmentFilePaths: [17], workspaceId: null, filesystemGrantId: null,
    } })
    const current = await read(owner, '43')
    expect('plan' in current && Object.keys(current.plan.deliveryTargets)).toEqual(['qq'])
    expect(await read(other, '43')).toEqual({ error: '任务不存在或已停用' })
    await runtime.db.updateTable('scheduled_tasks').set({ channels: 'im' }).where('id', '=', 43).execute()
    expect(await read(owner, '43')).toEqual({ error: '一个定时任务目前只能设置一个群聊投递目标' })
  })

  it('返回业务选择所需字段和微秒精度结束时间，并隐藏异主/不存在任务', async () => {
    const read = createKyselyScheduledTaskRunNowReader(runtime.db, 'sqlite')
    expect(await read(owner.toUpperCase(), '42')).toEqual({
      scheduleKind: 'cron', enabled: true, endAt: Date.parse('2026-01-01T12:34:56.123Z'), lastRunFailed: false,
    })
    expect(await read(owner, '43')).toMatchObject({ scheduleKind: 'once', lastRunFailed: true })
    expect(await read(owner, '44')).toBeNull()
    expect(await read(owner, '999')).toBeNull()
  })

  it('拒绝非法 owner 和任务 ID，不把无效输入当成不存在', async () => {
    const read = createKyselyScheduledTaskRunNowReader(runtime.db, 'sqlite')
    await expect(read('invalid-owner', '42')).rejects.toThrow()
    for (const id of ['0', '-1', '1e2', '9007199254740992'])
      await expect(read(owner, id)).rejects.toThrow('定时任务 ID 无效')
  })
})
