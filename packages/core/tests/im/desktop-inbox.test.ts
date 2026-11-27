import { createSqliteInboundStore } from '../../src/im/desktop-inbox-store.js'
import { assertInboundRecordContract } from './inbox-contract.js'
import { applyReflectionFileWrite } from '../../src/agent/memory/reflection/window.js'
import { createDesktopGroupContextSearch } from '../../src/im/desktop-group-context.js'
import { createDesktopChatAttachmentStore } from '../../src/agent/attachments/desktop-store.js'
import { createDesktopImProjectionTransfer } from '../../src/runtime/desktop-im-projection-transfer.js'
import { createSqliteAgentAdmission } from '../../src/agent/run/sqlite-admission.js'
import { resetAgentSessionContext } from '../../src/agent/sessions/delete-data.js'
import { clearDesktopWorkspaceBindings, manageDesktopSessionGoal, readDesktopAgentHistoryPage } from '../../src/agent/sessions/desktop.js'
import { createSqliteAgentSessionSource } from '../../src/agent/context/sqlite-source.js'
import { selectSessionHistory } from '../../src/agent/context/history/ordering.js'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { expect, it } from 'vitest'
import { initializeSqlite, openSqliteRuntime } from '../../src/data/sqlite.js'
import { readDesktopImAttachmentReference, desktopImAttachmentDelivery, desktopImGroupRunEvent, recordDesktopImGroupMessage, resumeDesktopImPendingAsk, readPendingDesktopImConnection, admitDesktopImEvent, prepareDesktopImEvent, updateDesktopImDelivery, nextDesktopQqSequence, desktopImProjection, desktopImPrompt, rejectDesktopImEvent } from '../../src/im/desktop-inbox.js'

it('QQ 群聊保存已确认的 Bot 身份并仅在历史展示映射提及', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-im-bot-mention-'))
  try {
    const path = join(directory, 'test.db')
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const connection = { platform: 'qq', connectionId: 'a'.repeat(64), eventKey: 'b'.repeat(64), sealedEvent: 'AQ==' }
      await admitDesktopImEvent(runtime.db, ownerId, connection)
      const incoming = await prepareDesktopImEvent(runtime.db, ownerId, { ...connection, chatType: 'group', ownerPlatformUserId: 'owner' })
      if (!incoming) throw new Error('收件未准备')
      const text = '<@synthetic-bot>、<@other-bot> 和 <@unknown> 你好'
      await createSqliteAgentAdmission(runtime.db).prepare(ownerId, { session_id: incoming.sessionId, message: text,
        quotedText: '<@synthetic-bot> 和 <@other-bot> 旧消息', client_message_id: incoming.clientId,
        groupSender: { id: 'sender', name: '小北', botId: 'synthetic-bot',
          otherBotNames: [{ id: 'other-bot', name: '小南' }] } })
      const stored = await sql<{ content: string; platform_bot_user_id: string }>`SELECT content,platform_bot_user_id
        FROM conversation_messages WHERE session_id=${incoming.sessionId} AND role='user'`.execute(runtime.db)
      expect(stored.rows[0]).toEqual({ content: text, platform_bot_user_id: 'synthetic-bot' })
      const history = await readDesktopAgentHistoryPage(runtime.db, ownerId, incoming.sessionId)
      expect(history.messages.find(message => message.role === 'user')).toMatchObject({
        text: '@咕咕、@小南 和 <@unknown> 你好', quotedText: '@咕咕 和 @小南 旧消息',
      })
    } finally { await runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('重启后为同一收件恢复原会话和消息标识，隔离其他连接', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-im-inbox-'))
  const path = join(directory, 'test.db')
  let opened: Awaited<ReturnType<typeof openSqliteRuntime>> | undefined
  try {
    await initializeSqlite(path)
    opened = await openSqliteRuntime(path)
    const connection = { platform: 'telegram', connectionId: 'a'.repeat(64) }
    const event = { ...connection, eventKey: 'event-1', sealedEvent: 'AQ==' }
    const scope = { ...connection, ownerId: opened.ownerId.replaceAll('-', '') }
    const store = createSqliteInboundStore(opened.runtime.db)
    await assertInboundRecordContract(() => store.recordInbound({ ...scope, eventKey: event.eventKey,
      clientId: 'synthetic-test-client', payload: Buffer.from(event.sealedEvent, 'base64') }))
    expect(await store.resumeDelivery(scope)).toBeNull()
    await opened.runtime.close()
    opened = await openSqliteRuntime(path)
    const first = await prepareDesktopImEvent(opened.runtime.db, opened.ownerId, connection)
    expect(first).toMatchObject({ eventKey: event.eventKey, sealedEvent: event.sealedEvent, runId: null })
    await opened.runtime.close()
    opened = await openSqliteRuntime(path)
    await expect(admitDesktopImEvent(opened.runtime.db, opened.ownerId, { ...event, sealedEvent: 'Ag==' })).resolves.toBe(false)
    expect(await prepareDesktopImEvent(opened.runtime.db, opened.ownerId, connection)).toEqual(first)
    expect(await prepareDesktopImEvent(opened.runtime.db, opened.ownerId, { ...connection, connectionId: 'b'.repeat(64) })).toBeNull()
    if (!first) throw new Error('收件未准备')
    const admitted = await createSqliteAgentAdmission(opened.runtime.db).prepare(opened.ownerId, {
      session_id: first.sessionId, message: '测试收件', client_message_id: first.clientId,
    })
    await opened.runtime.close()
    opened = await openSqliteRuntime(path)
    expect(await prepareDesktopImEvent(opened.runtime.db, opened.ownerId, connection)).toEqual({
      ...first, runId: admitted.identity.runId,
    })
    expect(await prepareDesktopImEvent(opened.runtime.db, opened.ownerId, connection)).toMatchObject({
      runId: admitted.identity.runId,
    })
    const recoveredStore = createSqliteInboundStore(opened.runtime.db)
    expect(await recoveredStore.claimInbound(scope)).toBeNull()
    expect(await recoveredStore.resumeDelivery(scope)).toMatchObject({ run_id: admitted.identity.runId })
    const admissions = await sql<{ run_id: string }>`SELECT run_id FROM agent_run_admissions
      WHERE session_id=${first.sessionId}`.execute(opened.runtime.db)
    expect(admissions.rows).toEqual([{ run_id: admitted.identity.runId }])
    const key = { ...connection, eventKey: event.eventKey, runId: admitted.identity.runId }
    const owner = opened.ownerId.replaceAll('-', '')
    const db = opened.runtime.db
    await sql`INSERT INTO agent_run_checkpoints (user_id,session_id,run_id,version,sequence,status,phase,nonce,payload) VALUES
      (${owner},${first.sessionId},${key.runId},1,0,'waiting','interaction',X'00',X'00')`.execute(db)
    await sql`INSERT INTO interaction_prompts(id,user_id,session_id,kind,title,body,schema_json,status,expires_at,created_at)
      VALUES (1,${owner},${first.sessionId},'form','','','{}','active','2027-01-01 00:00:00','2026-11-21 00:00:00')`.execute(db)
    await sql`INSERT INTO agent_interaction_bindings VALUES
      (${owner},${first.sessionId},${key.runId},'interaction','tool',1)`.execute(db)
    const prompt = { ...key, promptId: 1 }
    expect(await desktopImPrompt(db, opened.ownerId, { ...prompt, runId: 'other', action: 'begin' })).toBe(false)
    expect(await desktopImPrompt(db, opened.ownerId, { ...prompt, action: 'begin' })).toBe(true)
    expect(await desktopImPrompt(db, opened.ownerId, { ...prompt, action: 'begin' })).toBe(false)
    const lookup = { ...connection, action: 'lookup', promptId: 1, messageId: 'platform-message' }
    expect(await desktopImPrompt(db, opened.ownerId, lookup)).toBeNull()
    expect(await desktopImPrompt(db, opened.ownerId, { ...prompt, action: 'settle', messageId: lookup.messageId })).toBe(true)
    expect(await desktopImPrompt(db, opened.ownerId, { ...lookup, messageId: 'other' })).toBeNull()
    expect(await desktopImPrompt(db, opened.ownerId, lookup)).toEqual({ sessionId: first.sessionId, runId: key.runId })
    const textKey = 'f'.repeat(64)
    const textLookup = { ...connection, action: 'lookup-text', eventKey: textKey }
    expect(await desktopImPrompt(db, opened.ownerId, textLookup)).toBeNull()
    const choiceSchema = { source: 'agent', context: { tool_name: 'ask_user' }, allow_text_input: true,
      options: [{ id: 'one' }, { id: '__custom_reply__' }], custom_input_active: true }
    await sql`UPDATE interaction_prompts SET kind='choice',
      schema_json=${JSON.stringify({ ...choiceSchema, custom_input_active: false })} WHERE id=1`.execute(db)
    expect(await desktopImPrompt(db, opened.ownerId, textLookup)).toBeNull()
    await sql`UPDATE interaction_prompts SET kind='question',
      schema_json=${JSON.stringify({ ...choiceSchema, custom_input_active: false, options: [{ id: '__custom_reply__' }] })} WHERE id=1`.execute(db)
    expect(await desktopImPrompt(db, opened.ownerId, textLookup)).toMatchObject({ promptId: 1, replayed: 0 })
    await sql`UPDATE interaction_prompts SET kind='choice', schema_json=${JSON.stringify(choiceSchema)} WHERE id=1`.execute(db)
    expect(await desktopImPrompt(db, opened.ownerId, textLookup)).toEqual({ sessionId: first.sessionId, runId: key.runId, promptId: 1, replayed: 0 })
    expect(await desktopImPrompt(db, opened.ownerId, { ...textLookup, connectionId: 'c'.repeat(64) })).toBeNull()
    await sql`UPDATE interaction_prompts SET status='resolved',
      schema_json=${JSON.stringify({ ...choiceSchema, desktop_text_event_id: textKey })} WHERE id=1`.execute(db)
    expect(await desktopImPrompt(db, opened.ownerId, textLookup)).toMatchObject({ replayed: 1 })
    expect(await desktopImPrompt(db, opened.ownerId, { ...textLookup, eventKey: 'e'.repeat(64) })).toBeNull()
    const projection = { ...key, key: 'qq:0:1:1:frame', fingerprint: 'a'.repeat(64) }
    expect(await desktopImProjection(db, opened.ownerId, { ...projection, action: 'read' })).toEqual({ version: 0, state: null })
    expect(await desktopImProjection(db, opened.ownerId, { ...projection, action: 'checkpoint', version: 0, state: 'AQ==' })).toBe(1)
    expect(await desktopImProjection(db, opened.ownerId, { ...projection, action: 'begin' })).toBe('new')
    await expect(desktopImProjection(db, opened.ownerId, { ...projection, action: 'accepted', version: 0, state: 'Ag==' })).rejects.toMatchObject({ code: 'conflict' })
    expect(await desktopImProjection(db, opened.ownerId, { ...projection, action: 'begin' })).toBe('pending')
    expect(await desktopImProjection(db, opened.ownerId, { ...projection, action: 'accepted', version: 1, state: 'Ag==' })).toBe(2)
    await expect(desktopImProjection(db, opened.ownerId, { ...projection, action: 'read', runId: 'other' })).rejects.toMatchObject({ code: 'not_found' })
    const transfer = createDesktopImProjectionTransfer()
    const uploadId = '00000000-0000-4000-8000-000000000001'
    const stage = { ...projection, action: 'stage', uploadId, total: 4 }
    const firstChunk = 'A'.repeat(24_000)
    expect(transfer({ ...stage, part: 0, chunk: firstChunk })).toBeNull()
    expect(() => transfer({ ...projection, action: 'checkpoint', version: 2, uploadId })).toThrow()
    expect(() => transfer({ ...stage, runId: 'other', part: 1, chunk: 'Ag==' })).toThrow()
    expect(transfer({ ...stage, part: 1, chunk: firstChunk })).toBeNull()
    expect(transfer({ ...stage, part: 2, chunk: firstChunk })).toBeNull()
    expect(transfer({ ...stage, part: 3, chunk: 'Ag==' })).toBeNull()
    const checkpoint = transfer({ ...projection, action: 'checkpoint', version: 2, uploadId })
    if (!checkpoint) throw new Error('缺少组装后的检查点')
    expect(await desktopImProjection(db, opened.ownerId, checkpoint)).toBe(3)
    expect(() => transfer({ ...projection, action: 'checkpoint', version: 2, uploadId })).toThrow()
    expect(await nextDesktopQqSequence(db, opened.ownerId, { botId: 'qq-bot', messageId: 'source' })).toBe(1)
    expect(await nextDesktopQqSequence(db, opened.ownerId, { botId: 'qq-bot' })).toBe(1)
    const pendingProjection = { ...projection, key: 'qq:0:2:1:frame' }
    expect(await desktopImProjection(db, opened.ownerId, { ...pendingProjection, action: 'begin' })).toBe('new')
    const notice = { ...key, noticeKey: 'a'.repeat(64) }
    expect(await updateDesktopImDelivery(db, opened.ownerId, { ...notice, runId: 'other', action: 'begin' })).toBe(false)
    expect(await updateDesktopImDelivery(db, opened.ownerId, { ...notice, action: 'begin' })).toBe(true)
    await opened.runtime.close()
    opened = await openSqliteRuntime(path)
    expect(await nextDesktopQqSequence(opened.runtime.db, opened.ownerId, { botId: 'qq-bot', messageId: 'source' })).toBe(2)
    expect(await nextDesktopQqSequence(opened.runtime.db, opened.ownerId, { botId: 'other-bot', messageId: 'source' })).toBe(1)
    expect(await desktopImProjection(opened.runtime.db, opened.ownerId, { ...projection, action: 'begin' })).toBe('accepted')
    expect(await desktopImProjection(opened.runtime.db, opened.ownerId, { ...pendingProjection, action: 'begin' })).toBe('pending')
    expect(await desktopImProjection(opened.runtime.db, opened.ownerId, { ...projection, action: 'read' })).toEqual({ version: 3, state: firstChunk.repeat(3) + 'Ag==' })
    expect(await updateDesktopImDelivery(opened.runtime.db, opened.ownerId, { ...notice, action: 'begin' })).toBe(false)
    expect(await updateDesktopImDelivery(opened.runtime.db, opened.ownerId, { ...notice, action: 'unknown' })).toBe(true)
    const nextEvent = { ...event, eventKey: 'event-2' }
    expect(await admitDesktopImEvent(opened.runtime.db, opened.ownerId, nextEvent)).toBe(true)
    expect(await prepareDesktopImEvent(opened.runtime.db, opened.ownerId, connection)).toMatchObject({ runId: key.runId })
    expect(await updateDesktopImDelivery(opened.runtime.db, opened.ownerId, { ...key, runId: 'other', action: 'begin' })).toBe(false)
    expect(await updateDesktopImDelivery(opened.runtime.db, opened.ownerId, { ...key, action: 'begin' })).toBe(true)
    await opened.runtime.close()
    opened = await openSqliteRuntime(path)
    expect(await updateDesktopImDelivery(opened.runtime.db, opened.ownerId, { ...key, action: 'begin' })).toBe(false)
    expect(await updateDesktopImDelivery(opened.runtime.db, opened.ownerId, { ...key, action: 'unknown' })).toBe(true)
    expect(await prepareDesktopImEvent(opened.runtime.db, opened.ownerId, connection)).toMatchObject({ eventKey: nextEvent.eventKey, runId: null })
    expect(await rejectDesktopImEvent(opened.runtime.db, opened.ownerId, nextEvent)).toBe(true)
    await admitDesktopImEvent(opened.runtime.db, opened.ownerId, { ...event, eventKey: 'invalid' })
    await admitDesktopImEvent(opened.runtime.db, opened.ownerId, { ...event, eventKey: 'next' })
    expect(await rejectDesktopImEvent(opened.runtime.db, opened.ownerId, { ...connection, eventKey: 'invalid' })).toBe(true)
    expect(await prepareDesktopImEvent(opened.runtime.db, opened.ownerId, connection)).toMatchObject({ eventKey: 'next' })
  } finally {
    await opened?.runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('桌面收件与附件暂存原子提交，重复收件不创建附件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-im-inbox-'))
  const path = join(directory, 'test.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const connection = { platform: 'telegram', connectionId: 'a'.repeat(64) }
      const event = { ...connection, eventKey: 'event-1', sealedEvent: 'AQ==', sourceMessageId: '10:20:30' }
      const attachment = { attachId: 'a'.repeat(32), name: '测试', ext: 'png', mime: 'image/png', size: 100, voice: false, sourceIndex: 0, quoted: true }
      await expect(admitDesktopImEvent(runtime.db, ownerId, { ...event,
        attachments: [attachment, { ...attachment, attachId: 'invalid' }] })).rejects.toMatchObject({ code: 'invalid_request' })
      expect(await prepareDesktopImEvent(runtime.db, ownerId, connection)).toBeNull()
      await expect(admitDesktopImEvent(runtime.db, ownerId, { ...event, attachments: [attachment] })).resolves.toBe(true)
      await expect(admitDesktopImEvent(runtime.db, ownerId, { ...event,
        attachments: [{ ...attachment, attachId: 'b'.repeat(32) }] })).resolves.toBe(false)
      const { rows } = await sql`SELECT attach_id FROM chat_attachments`.execute(runtime.db)
      expect(rows).toEqual([{ attach_id: attachment.attachId }])
      const store = createDesktopChatAttachmentStore(runtime.db)
      expect(await store.deleteDraftRows(ownerId)).toEqual([])
      expect(await store.deleteDraft(ownerId, attachment.attachId)).toBeNull()
      const reference = { ...connection, sourceMessageId: event.sourceMessageId, sourceIndex: 0 }
      expect(await readDesktopImAttachmentReference(runtime.db, ownerId, reference)).toMatchObject({ attachId: attachment.attachId })
      expect(await readDesktopImAttachmentReference(runtime.db, ownerId, { ...reference, connectionId: 'b'.repeat(64) })).toBeNull()
      expect(await readDesktopImAttachmentReference(runtime.db, ownerId, { ...reference, sourceIndex: 1 })).toBeNull()
      const prepared = await prepareDesktopImEvent(runtime.db, ownerId, connection)
      if (!prepared) throw new Error('收件未准备')
      const admission = createSqliteAgentAdmission(runtime.db)
      await expect(admission.prepare(ownerId, {
        session_id: prepared.sessionId, message: '测试', client_message_id: 'other', attachments: [attachment.attachId],
      })).rejects.toMatchObject({ code: 'not_found' })
      const { identity } = await admission.prepare(ownerId, {
        session_id: prepared.sessionId, message: '测试', client_message_id: prepared.clientId, attachments: [attachment.attachId],
      })
      expect(await store.forSession(ownerId, prepared.sessionId)).toEqual([attachment.attachId])
      const { rows: [message] } = await sql<{ files: string }>`SELECT files FROM conversation_messages
        WHERE session_id=${prepared.sessionId} AND client_message_id=${prepared.clientId}`.execute(runtime.db)
      expect(JSON.parse(message!.files)).toMatchObject([{ attach_id: attachment.attachId, quoted: true }])

      expect(await readDesktopImAttachmentReference(runtime.db, ownerId, reference)).toMatchObject({ attachId: attachment.attachId })
      await sql`UPDATE conversation_sessions SET chat_type=NULL WHERE id=${prepared.sessionId}`.execute(runtime.db)
      const { rows: [previous] } = await sql<{ id: number }>`
        INSERT INTO conversation_messages(session_id,conversation_seq,role,content,created_at)
        VALUES (${prepared.sessionId},0,'user','测试历史附件',CURRENT_TIMESTAMP) RETURNING id`.execute(runtime.db)
      await sql`UPDATE chat_attachments SET message_id=${previous!.id} WHERE attach_id=${attachment.attachId}`.execute(runtime.db)
      const delivery = (action: Parameters<typeof desktopImAttachmentDelivery>[3]) =>
        desktopImAttachmentDelivery(runtime.db, identity, attachment.attachId, action)
      expect(await desktopImAttachmentDelivery(runtime.db, identity, 'b'.repeat(32), 'begin')).toBeNull()
      expect(await desktopImAttachmentDelivery(runtime.db, { ...identity, runId: 'other' }, attachment.attachId, 'begin')).toBeNull()
      expect(await delivery('begin')).toMatchObject({ state: 'new', ...connection, eventKey: event.eventKey })
      expect(await delivery('begin')).toEqual({ state: 'unknown' })
      const reopened = await openSqliteRuntime(path)
      try {
        expect(await desktopImAttachmentDelivery(reopened.runtime.db, identity, attachment.attachId, 'begin')).toEqual({ state: 'unknown' })
      } finally { await reopened.runtime.close() }
      expect(await delivery('accepted')).toEqual({ state: 'accepted' })
      expect(await delivery('unknown')).toEqual({ state: 'accepted' })
      expect(await delivery('begin')).toEqual({ state: 'accepted' })
      const filePath = '/personal/示例.txt'
      expect(await desktopImAttachmentDelivery(runtime.db, identity, filePath, 'begin')).toMatchObject({ state: 'new', filePath, ...connection })
      expect(await desktopImAttachmentDelivery(runtime.db, identity, filePath, 'begin')).toEqual({ state: 'unknown' })

    } finally { await runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('群聊附件只能由当前群运行发送，个人路径仍仅限私聊', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-im-inbox-group-file-'))
  const path = join(directory, 'test.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const connection = { platform: 'qq', connectionId: 'd'.repeat(64) }
      const attachId = 'b'.repeat(32)
      const event = { ...connection, eventKey: 'group-file-event', sealedEvent: 'AQ==',
        attachments: [{ attachId, name: '群图片', ext: 'png', mime: 'image/png', size: 3, voice: false }] }
      await admitDesktopImEvent(runtime.db, ownerId, event)
      const prepared = await prepareDesktopImEvent(runtime.db, ownerId, { ...connection, chatType: 'group', ownerPlatformUserId: 'owner-platform-user' })
      if (!prepared) throw new Error('群收件未准备')
      const { identity } = await createSqliteAgentAdmission(runtime.db).prepare(ownerId, {
        session_id: prepared.sessionId, message: '查看这张图', client_message_id: prepared.clientId, attachments: [attachId],
      })
      const delivery = (source: string, action: Parameters<typeof desktopImAttachmentDelivery>[3]) =>
        desktopImAttachmentDelivery(runtime.db, identity, source, action)
      expect(await delivery(attachId, 'begin')).toMatchObject({ state: 'new', ...connection, eventKey: event.eventKey })
      expect(await delivery(attachId, 'accepted')).toEqual({ state: 'accepted' })
      expect(await delivery('/personal/private.png', 'begin')).toBeNull()
      expect(await delivery('c'.repeat(32), 'begin')).toBeNull()
    } finally { await runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('桌面群收件保留群会话类型，并拒绝复用为私聊', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-im-inbox-'))
  const path = join(directory, 'test.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const connection = { platform: 'qq', connectionId: 'c'.repeat(64) }
      await admitDesktopImEvent(runtime.db, ownerId, { ...connection, eventKey: 'group', sealedEvent: 'AQ==' })
      expect(await readPendingDesktopImConnection(runtime.db, ownerId, { platform: 'qq' }))
        .toEqual({ connectionId: connection.connectionId, eventKey: 'group', sealedEvent: 'AQ==' })
      expect(await readPendingDesktopImConnection(runtime.db, ownerId, { platform: 'qq', after: connection.connectionId }))
        .toBeNull()
      const group = await prepareDesktopImEvent(runtime.db, ownerId, { ...connection, chatType: 'group' })
      const { rows } = await sql`SELECT chat_type FROM conversation_sessions WHERE id=${group?.sessionId}`.execute(runtime.db)
      expect(rows).toEqual([{ chat_type: 'group' }])
      await expect(prepareDesktopImEvent(runtime.db, ownerId, connection)).rejects.toMatchObject({ code: 'conflict' })
    } finally { await runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('普通群消息按平台时间进入后续 AT 运行历史，且不创建独立运行', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-im-context-order-'))
  try {
    const path = join(directory, 'test.db')
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const db = runtime.db
      const scope = { platform: 'qq', connectionId: 'a'.repeat(64), ownerPlatformUserId: 'owner' }
      for (const [index, seconds] of [49, 46, 50, 52].entries())
        await recordDesktopImGroupMessage(db, ownerId, { ...scope, eventKey: String(index + 1).repeat(64),
          text: `群消息 ${seconds}`, platformUserId: 'member', platformSentMs: seconds * 1000, eventReceivedMs: (60 + index) * 1000 })
      expect(await prepareDesktopImEvent(db, ownerId, { ...scope, chatType: 'group' })).toBeNull()
      await admitDesktopImEvent(db, ownerId, { ...scope, eventKey: 'b'.repeat(64), sealedEvent: 'AQ==' })
      const turn = await prepareDesktopImEvent(db, ownerId, { ...scope, chatType: 'group' })
      if (!turn) throw new Error('AT 收件未准备')
      const { identity } = await createSqliteAgentAdmission(db).prepare(ownerId, {
        session_id: turn.sessionId, message: '下一条 AT', client_message_id: turn.clientId,
        groupSender: { id: 'owner', platformSentMs: 59_000, eventReceivedMs: 64_000 },
      })
      const source = createSqliteAgentSessionSource(db)
      const history = await source.historyReader.read(identity)
      expect(selectSessionHistory(identity, history.rows, history.baselineSeq).rows.map(row => row.content))
        .toEqual(['群消息 46', '群消息 49', '群消息 50', '群消息 52', '下一条 AT'])
      expect((await source.currentTurn(identity)).currentUser?.messageTimestamp).toBe(59_000)
    } finally { await runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('仅记录的群消息只写一条历史，切到回应模式后重放也不会入队', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-im-inbox-'))
  const path = join(directory, 'test.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const event = { platform: 'qq', connectionId: 'c'.repeat(64), eventKey: 'd'.repeat(64), text: '测试群记录', quotedText: '被引用的原文', platformUserId: 'sender', platformUserName: '小北' }
      const changed: number[] = []
      const record = () => recordDesktopImGroupMessage(runtime.db, ownerId, event, undefined, id => changed.push(id))
      expect(await record()).toBe(true)
      expect(await record()).toBe(false)
      const { rows: [recordedSession] } = await sql<{ session_id: number }>`SELECT session_id FROM desktop_im_sessions`.execute(runtime.db)
      expect(changed).toEqual([recordedSession!.session_id])
      const history = await readDesktopAgentHistoryPage(runtime.db, ownerId, recordedSession!.session_id)
      expect(history.messages).toMatchObject([{ text: event.text, quotedText: event.quotedText }])
      await admitDesktopImEvent(runtime.db, ownerId, { ...event, sealedEvent: 'AQ==' })
      expect(await readPendingDesktopImConnection(runtime.db, ownerId, { platform: 'qq' })).toBeNull()
      const { rows } = await sql`SELECT role,content FROM conversation_messages`.execute(runtime.db)
      expect(rows).toEqual([{ role: 'user', content: '测试群记录' }])
      const attachment = { attachId: 'a'.repeat(32), name: '测试图片', ext: 'png', mime: 'image/png', size: 100, voice: false }
      const image = { ...event, eventKey: 'e'.repeat(64), text: '', attachments: [attachment] }
      expect(await recordDesktopImGroupMessage(runtime.db, ownerId, image)).toBe(true)
      expect(await recordDesktopImGroupMessage(runtime.db, ownerId, image)).toBe(false)
      const stored = await createDesktopChatAttachmentStore(runtime.db).download(ownerId, attachment.attachId)
      expect(stored).toMatchObject({ name: '测试图片', mime: 'image/png' })
      const saved = await sql<{ files: string }>`SELECT files FROM conversation_messages WHERE content=''`.execute(runtime.db)
      expect(saved.rows.map(row => JSON.parse(row.files))).toEqual([[expect.objectContaining({ attach_id: attachment.attachId })]])
      const other = { ...event, connectionId: 'f'.repeat(64), text: '测试其他群' }
      await recordDesktopImGroupMessage(runtime.db, ownerId, other)
      const session = (await sql<{ session_id: number }>`SELECT session_id FROM desktop_im_sessions
        WHERE connection_id=${event.connectionId}`.execute(runtime.db)).rows[0]!
      const batch = (await sql<{ id: number }>`INSERT INTO conversation_batches(session_id,version,run_id,round_id,digest,created_at)
        VALUES(${session.session_id},'v1','technical','round-1','synthetic','2026-01-01T00:00:00Z') RETURNING id`.execute(runtime.db)).rows[0]!
      await sql`INSERT INTO conversation_messages(session_id,conversation_seq,role,content,canonical_batch_id,created_at)
        VALUES(${session.session_id},3,'user','测试内部工具回执',${batch.id},'2026-01-01T00:00:00Z')`.execute(runtime.db)
      await sql`UPDATE conversation_sessions SET last_message_seq=3 WHERE id=${session.session_id}`.execute(runtime.db)
      const incoming = { ...event, eventKey: '1'.repeat(64), sealedEvent: 'AQ==' }
      await admitDesktopImEvent(runtime.db, ownerId, incoming)
      await admitDesktopImEvent(runtime.db, ownerId, { ...incoming, eventKey: '3'.repeat(64), sealedEvent: 'Ag==' })
      const prepared = await prepareDesktopImEvent(runtime.db, ownerId, { ...event, chatType: 'group' })
      if (!prepared) throw new Error('收件未准备')
      const { identity } = await createSqliteAgentAdmission(runtime.db).prepare(ownerId, {
        session_id: prepared.sessionId, message: '测试当前轮', client_message_id: prepared.clientId,
      })
      expect(await desktopImGroupRunEvent(runtime.db, identity)).toMatchObject({ eventKey: incoming.eventKey, sealedEvent: 'AQ==' })
      const recovered = await prepareDesktopImEvent(runtime.db, ownerId, { ...event, chatType: 'group' })
      expect(recovered?.runId).toBe(identity.runId)
      expect(await desktopImGroupRunEvent(runtime.db, identity)).toMatchObject({ eventKey: incoming.eventKey, sealedEvent: 'AQ==' })
      expect(await desktopImGroupRunEvent(runtime.db, { ...identity, runId: 'other-run' })).toBeNull()

      await recordDesktopImGroupMessage(runtime.db, ownerId, { ...event, eventKey: '2'.repeat(64), text: '测试后来消息' })
      const request = { keyword: '测试', queries: ['测试'], mode: 'OR' as const, limit: 10, speaker: '' }
      const signal = new AbortController().signal
      const search = createDesktopGroupContextSearch(runtime.db, async () => true)
      expect(await search.search(identity, request, signal)).toEqual({
        messages: [expect.objectContaining({ text: '测试群记录' })],
      })
      expect(await search.search(identity, { ...request, speaker: '小北' }, signal)).toEqual({
        messages: [expect.objectContaining({ text: '测试群记录', platform_user_name: '小北' })],
      })
      expect(await search.search(identity, { ...request, speaker: 'sender' }, signal)).toEqual({
        messages: [expect.objectContaining({ text: '测试群记录' })],
      })
      const revoked = createDesktopGroupContextSearch(runtime.db, async () => false)
      expect(await revoked.search(identity, request, signal)).toEqual({ error: '群消息搜索未授权' })


    } finally { await runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('飞书和 Telegram 使用通用桌面群会话与收件恢复身份', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-im-group-platforms-'))
  const path = join(directory, 'test.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      for (const [index, platform] of (['feishu', 'telegram'] as const).entries()) {
        const connectionId = String(index + 1).repeat(64)
        const event = { platform, connectionId, eventKey: String(index + 3).repeat(64), text: `测试${platform}群`,
          platformUserId: 'sender', platformUserName: '小北', ownerPlatformUserId: 'owner' }
        expect(await recordDesktopImGroupMessage(runtime.db, ownerId, event)).toBe(true)
        const incoming = { ...event, eventKey: String(index + 5).repeat(64), sealedEvent: 'AQ==' }
        await admitDesktopImEvent(runtime.db, ownerId, incoming)
        const prepared = await prepareDesktopImEvent(runtime.db, ownerId, { ...event, chatType: 'group' })
        if (!prepared) throw new Error('收件未准备')
        const { identity } = await createSqliteAgentAdmission(runtime.db).prepare(ownerId, {
          session_id: prepared.sessionId, message: event.text, client_message_id: prepared.clientId,
        })
        expect(await desktopImGroupRunEvent(runtime.db, identity)).toMatchObject({
          platform, connectionId, eventKey: incoming.eventKey, sealedEvent: 'AQ==',
        })
      }
    } finally { await runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('飞书和 Telegram 的延迟 ASK 复用被动历史消息，不重复追加用户消息', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-im-pending-ask-'))
  const path = join(directory, 'test.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      for (const [index, platform] of (['feishu', 'telegram'] as const).entries()) {
        const connectionId = String(index + 6).repeat(64)
        const eventKey = String(index + 8).repeat(64)
        const text = `延迟问题${platform}`
        const event = { platform, connectionId, eventKey, text, platformUserId: 'member',
          platformUserName: '小北', ownerPlatformUserId: 'owner' }
        expect(await recordDesktopImGroupMessage(runtime.db, ownerId, event)).toBe(true)
        expect(await resumeDesktopImPendingAsk(runtime.db, ownerId, { platform, connectionId, eventKey,
          sealedEvent: 'AQ==', ownerPlatformUserId: 'owner', platformUserId: 'member', text })).toBe(true)
        const prepared = await prepareDesktopImEvent(runtime.db, ownerId, { platform, connectionId,
          chatType: 'group', ownerPlatformUserId: 'owner' })
        if (!prepared) throw new Error('延迟收件未准备')
        const { identity } = await createSqliteAgentAdmission(runtime.db).prepare(ownerId, {
          session_id: prepared.sessionId, message: text, client_message_id: prepared.clientId,
          groupSender: { id: 'member', name: '小北' }, resumePassiveMessage: true,
        })
        const messages = await sql<{ content: string; conversation_seq: number }>`SELECT content,conversation_seq
          FROM conversation_messages WHERE session_id=${prepared.sessionId} ORDER BY conversation_seq`.execute(runtime.db)
        expect(messages.rows).toEqual([{ content: text, conversation_seq: 1 }])
        expect(await desktopImGroupRunEvent(runtime.db, identity)).toMatchObject({ platform, eventKey, connectionId })
        expect(await resumeDesktopImPendingAsk(runtime.db, ownerId, { platform, connectionId, eventKey,
          sealedEvent: 'AQ==', ownerPlatformUserId: 'owner', platformUserId: 'member', text })).toBe(false)
      }
    } finally { await runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('第 50 条去重后的被动消息持久化触发上界，重启不丢进度', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-im-reflection-'))
  const path = join(directory, 'test.db')
  let opened: Awaited<ReturnType<typeof openSqliteRuntime>> | undefined
  try {
    await initializeSqlite(path)
    opened = await openSqliteRuntime(path)
    const event = (n: number) => ({
      platform: 'telegram', connectionId: 'a'.repeat(64), eventKey: n.toString(16).padStart(64, '0'),
      platformUserId: 'synthetic-member', text: '合成被动消息',
    })
    for (let n = 1; n < 50; n++)
      expect(await recordDesktopImGroupMessage(opened.runtime.db, opened.ownerId, event(n))).toBe(true)
    expect(await recordDesktopImGroupMessage(opened.runtime.db, opened.ownerId, event(49))).toBe(false)
    const state = sql`SELECT passive_count,requested_sequence FROM desktop_im_reflection_triggers`
    expect((await state.execute(opened.runtime.db)).rows).toEqual([{ passive_count: 49, requested_sequence: 0 }])
    await opened.runtime.close()
    opened = await openSqliteRuntime(path)
    let wakes = 0
    const wake = () => { wakes++ }
    expect(await recordDesktopImGroupMessage(opened.runtime.db, opened.ownerId, event(50), wake)).toBe(true)
    expect(await recordDesktopImGroupMessage(opened.runtime.db, opened.ownerId, event(50), wake)).toBe(false)
    expect(await recordDesktopImGroupMessage(opened.runtime.db, opened.ownerId, event(51), wake)).toBe(true)
    expect(wakes).toBe(1)
    expect((await state.execute(opened.runtime.db)).rows).toEqual([{ passive_count: 1, requested_sequence: 0 }])
    const threshold = await sql<{ through_sequence: number; due_at_ms: number }>`SELECT through_sequence,due_at_ms
      FROM desktop_im_reflection_thresholds`.execute(opened.runtime.db)
    expect(threshold.rows).toEqual([{ through_sequence: 50, due_at_ms: expect.any(Number) }])
    expect(threshold.rows[0]!.due_at_ms).toBeGreaterThan(Date.now() + 175_000)
  } finally {
    await opened?.runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('恢复已准备的文件计划时跳过已落盘文件，继续写入失败文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-im-reflection-write-'))
  try {
    const profile = join(directory, 'profile.json')
    const daily = join(directory, 'daily.md')
    await writeFile(profile, '原画像')
    await writeFile(daily, '原日记')
    let profileWrites = 0
    const writeProfile = () => applyReflectionFileWrite('原画像', '新画像',
      () => readFile(profile, 'utf8'), async value => { profileWrites++; await writeFile(profile, value) })
    expect(await writeProfile()).toBe(true)
    await expect(applyReflectionFileWrite('原日记', '新日记', () => readFile(daily, 'utf8'),
      async () => { throw new Error('模拟第二个文件写入失败') })).rejects.toThrow()
    expect(await writeProfile()).toBe(true)
    expect(await applyReflectionFileWrite('原日记', '新日记',
      () => readFile(daily, 'utf8'), value => writeFile(daily, value))).toBe(true)
    expect(profileWrites).toBe(1)
    expect(await readFile(daily, 'utf8')).toBe('新日记')
    await writeFile(daily, '外部编辑')
    expect(await applyReflectionFileWrite('原日记', '新日记',
      () => readFile(daily, 'utf8'), value => writeFile(daily, value))).toBe(false)
    expect(await readFile(daily, 'utf8')).toBe('外部编辑')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('/new 拒绝重置运行中的 IM 会话，空闲时清除旧对话并保留工作区绑定', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-im-new-'))
  try {
    const path = join(directory, 'test.db')
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const connection = { platform: 'qq', connectionId: 'a'.repeat(64), eventKey: 'b'.repeat(64), sealedEvent: 'AQ==' }
      await admitDesktopImEvent(runtime.db, ownerId, connection)
      const event = await prepareDesktopImEvent(runtime.db, ownerId, connection)
      if (!event) throw new Error('收件未准备')
      const { sessionId } = event
      const workspace = { workspace_id: 'desktop:11111111-1111-4111-8111-111111111111' }
      await sql`UPDATE conversation_sessions SET session_context=${JSON.stringify({ workspace_binding: workspace, goal_text: '旧目标' })},
        summary='旧摘要',active_run_id='active',execution_state='running' WHERE id=${sessionId}`.execute(runtime.db)
      await sql`INSERT INTO conversation_messages (session_id,conversation_seq,role,content,created_at)
        VALUES (${sessionId},1,'user','旧消息',CURRENT_TIMESTAMP)`.execute(runtime.db)
      const reset = () => runtime.db.transaction().execute(tx => resetAgentSessionContext(tx, 'sqlite', ownerId, sessionId))
      expect(await reset()).toBeNull()
      await sql`UPDATE conversation_sessions SET active_run_id=NULL,execution_state='idle' WHERE id=${sessionId}`.execute(runtime.db)
      expect(await reset()).toEqual([])
      const state = (await sql<{ summary: string; session_context: string }>`SELECT summary,session_context FROM conversation_sessions
        WHERE id=${sessionId}`.execute(runtime.db)).rows[0]!
      expect(state.summary).toBe('')
      expect(JSON.parse(state.session_context)).toEqual({ workspace_binding: workspace })
      expect((await sql`SELECT id FROM conversation_messages WHERE session_id=${sessionId}`.execute(runtime.db)).rows).toEqual([])
    } finally { await runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('群聊目标只允许 Bot 所有者创建和管理，控制命令沿用同一会话目标', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-im-goal-'))
  try {
    const path = join(directory, 'test.db')
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const connection = { platform: 'qq', connectionId: 'a'.repeat(64), eventKey: 'b'.repeat(64), sealedEvent: 'AQ==' }
      await admitDesktopImEvent(runtime.db, ownerId, connection)
      const event = await prepareDesktopImEvent(runtime.db, ownerId, { ...connection, chatType: 'group', ownerPlatformUserId: '小北' })
      if (!event) throw new Error('收件未准备')
      const { sessionId } = event
      const scope = { platform: connection.platform, connectionId: connection.connectionId, groupSenderId: '小北' }
      await expect(manageDesktopSessionGoal(runtime.db, ownerId, sessionId, 'status', { ...scope, groupSenderId: '小南' })).rejects.toThrow('当前会话不存在')
      const run = await createSqliteAgentAdmission(runtime.db).prepare(ownerId, { session_id: sessionId, message: '/goal 整理测试材料',
        client_message_id: event.clientId, groupSender: { id: '小北', name: '小北' } })
      expect(run.goalMode).toBe(true)
      expect((await manageDesktopSessionGoal(runtime.db, ownerId, sessionId, 'status', scope)).text).toContain('整理测试材料')
      expect((await manageDesktopSessionGoal(runtime.db, ownerId, sessionId, 'pause', scope)).text).toContain('已暂停')
      expect((await manageDesktopSessionGoal(runtime.db, ownerId, sessionId, 'resume', scope)).text).toContain('已恢复')
      expect((await manageDesktopSessionGoal(runtime.db, ownerId, sessionId, 'cancel', scope)).text).toContain('已取消')
      expect((await manageDesktopSessionGoal(runtime.db, ownerId, sessionId, 'status', scope)).text).toContain('没有')
    } finally { await runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('删除工作区登记只解除匹配的会话绑定并使快照失效', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-im-workspace-unbind-'))
  try {
    const path = join(directory, 'test.db')
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const ids = ['desktop:11111111-1111-4111-8111-111111111111', 'desktop:22222222-2222-4222-8222-222222222222']
      for (const [index, id] of ids.entries()) {
        const connection = { platform: 'qq', connectionId: String(index + 1).repeat(64), eventKey: String(index + 1).repeat(64), sealedEvent: 'AQ==' }
        await admitDesktopImEvent(runtime.db, ownerId, connection)
        const event = await prepareDesktopImEvent(runtime.db, ownerId, connection)
        if (!event) throw new Error('收件未准备')
        await sql`UPDATE conversation_sessions SET session_context=${JSON.stringify({
          workspace_binding: { directory_id: id }, goal_text: '保留目标',
        })},snapshot_hash='旧快照' WHERE id=${event.sessionId}`.execute(runtime.db)
      }
      await clearDesktopWorkspaceBindings(runtime.db, ownerId, ids[0]!)
      await clearDesktopWorkspaceBindings(runtime.db, ownerId, ids[0]!)
      const { rows } = await sql<{ session_context: string; snapshot_hash: string | null }>`
        SELECT session_context,snapshot_hash FROM conversation_sessions ORDER BY id`.execute(runtime.db)
      expect(JSON.parse(rows[0]!.session_context)).toEqual({ goal_text: '保留目标' })
      expect(rows[0]!.snapshot_hash).toBeNull()
      expect(JSON.parse(rows[1]!.session_context).workspace_binding.directory_id).toBe(ids[1])
      expect(rows[1]!.snapshot_hash).toBe('旧快照')
    } finally { await runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
