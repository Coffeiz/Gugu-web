import { createDesktopGroupContextSearch } from '../../src/im/desktop-group-context.js'
import { createDesktopChatAttachmentStore } from '../../src/agent/attachments/desktop-store.js'
import { createDesktopImProjectionTransfer } from '../../src/runtime/desktop-im-projection-transfer.js'
import { createSqliteAgentAdmission } from '../../src/agent/run/sqlite-admission.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { expect, it } from 'vitest'
import { initializeSqlite, openSqliteRuntime } from '../../src/data/sqlite.js'
import { readDesktopImAttachmentReference, desktopImAttachmentDelivery, desktopImGroupRunEvent, recordDesktopImGroupMessage, resumeDesktopImPendingAsk, readPendingDesktopImConnection, admitDesktopImEvent, prepareDesktopImEvent, updateDesktopImDelivery, nextDesktopQqSequence, desktopImProjection, desktopImPrompt, rejectDesktopImEvent } from '../../src/im/desktop-inbox.js'

it('重启后为同一收件恢复原会话和消息标识，隔离其他连接', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-im-inbox-'))
  const path = join(directory, 'test.db')
  let opened: Awaited<ReturnType<typeof openSqliteRuntime>> | undefined
  try {
    await initializeSqlite(path)
    opened = await openSqliteRuntime(path)
    const connection = { platform: 'telegram', connectionId: 'a'.repeat(64) }
    const event = { ...connection, eventKey: 'event-1', sealedEvent: 'AQ==' }
    await admitDesktopImEvent(opened.runtime.db, opened.ownerId, event)
    await opened.runtime.close()
    opened = await openSqliteRuntime(path)
    const first = await prepareDesktopImEvent(opened.runtime.db, opened.ownerId, connection)
    expect(first).toMatchObject({ eventKey: event.eventKey, sealedEvent: event.sealedEvent, runId: null })
    await opened.runtime.close()
    opened = await openSqliteRuntime(path)
    await admitDesktopImEvent(opened.runtime.db, opened.ownerId, { ...event, sealedEvent: 'Ag==' })
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
    const key = { ...connection, eventKey: event.eventKey, runId: admitted.identity.runId }
    const owner = opened.ownerId.replaceAll('-', '')
    const db = opened.runtime.db
    await sql`INSERT INTO agent_run_checkpoints VALUES
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
    expect(await prepareDesktopImEvent(opened.runtime.db, opened.ownerId, connection)).toMatchObject({ runId: key.runId })
    expect(await updateDesktopImDelivery(opened.runtime.db, opened.ownerId, { ...key, runId: 'other', action: 'begin' })).toBe(false)
    expect(await updateDesktopImDelivery(opened.runtime.db, opened.ownerId, { ...key, action: 'begin' })).toBe(true)
    await opened.runtime.close()
    opened = await openSqliteRuntime(path)
    expect(await updateDesktopImDelivery(opened.runtime.db, opened.ownerId, { ...key, action: 'begin' })).toBe(false)
    expect(await updateDesktopImDelivery(opened.runtime.db, opened.ownerId, { ...key, action: 'unknown' })).toBe(true)
    expect(await prepareDesktopImEvent(opened.runtime.db, opened.ownerId, connection)).toBeNull()
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
      const attachment = { attachId: 'a'.repeat(32), name: '测试', ext: 'png', mime: 'image/png', size: 100, voice: false, sourceIndex: 0 }
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
      expect(await readDesktopImAttachmentReference(runtime.db, ownerId, reference)).toMatchObject({ attachId: attachment.attachId })
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

it('仅记录的群消息只写一条历史，切到回应模式后重放也不会入队', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-im-inbox-'))
  const path = join(directory, 'test.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const event = { platform: 'qq', connectionId: 'c'.repeat(64), eventKey: 'd'.repeat(64), text: '测试群记录', platformUserId: 'sender', platformUserName: '小北' }
      expect(await recordDesktopImGroupMessage(runtime.db, ownerId, event)).toBe(true)
      expect(await recordDesktopImGroupMessage(runtime.db, ownerId, event)).toBe(false)
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
