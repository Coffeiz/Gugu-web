import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { expect, it } from 'vitest'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { claimDesktopChatAttachments, createDesktopChatAttachmentStore } from '../../../src/agent/attachments/desktop-store.js'
import { renderOpenaiHistory } from '../../../src/agent/providers/openai/history.js'
import { restoreHistoryForRequest } from '../../../src/agent/context/history/ordering.js'
import { createSqliteAgentSessionSource } from '../../../src/agent/context/sqlite-source.js'
import { createSqliteAgentAdmission } from '../../../src/agent/run/sqlite-admission.js'
import { createDesktopAgentSession, readDesktopAgentMessages } from '../../../src/agent/sessions/desktop.js'

it('本机附件暂存后随消息原子认领、历史可重读且重复消息不会重复消费', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-desktop-attachment-'))
  const path = join(directory, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const session = await runtime.db.transaction().execute(tx => createDesktopAgentSession(tx, ownerId, '合成附件会话'))
      const attachId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
      const store = createDesktopChatAttachmentStore(runtime.db)
      expect(await store.stage(ownerId, { attachId, name: '设计稿', ext: 'txt', mime: 'text/plain', size: 14, voice: false }))
        .toMatchObject({ attach_id: attachId, kind: 'text', size: 14, upload: true })
      await expect(store.download(ownerId, attachId)).rejects.toMatchObject({ code: 'not_found' })
      const admission = createSqliteAgentAdmission(runtime.db)
      const input = { session_id: session.id, message: '请总结附件', client_message_id: 'client:test-1', attachments: [attachId], references: [] }
      const first = await admission.prepare(ownerId, input)
      const attachmentRow = await sql<{ state: string; message_id: number }>`SELECT state,message_id FROM chat_attachments
        WHERE user_id=${ownerId.replaceAll('-', '')} AND attach_id=${attachId}`.execute(runtime.db)
      expect(attachmentRow.rows).toEqual([{ state: 'attached', message_id: first.userMessageId }])
      const message = await sql<{ files: string; references_json: string | null }>`SELECT files,references_json
        FROM conversation_messages WHERE id=${first.userMessageId}`.execute(runtime.db)
      expect(JSON.parse(message.rows[0]!.files)).toMatchObject([{ attach_id: attachId, name: '设计稿', size_bytes: 14 }])
      expect(message.rows[0]!.references_json).toBeNull()
      expect(await readDesktopAgentMessages(runtime.db, ownerId, session.id)).toMatchObject([
        { text: '请总结附件', files: [{ attach_id: attachId, size_bytes: 14 }] },
      ])
      await expect(store.download('ffffffff-ffff-4fff-8fff-ffffffffffff', attachId)).rejects.toMatchObject({ code: 'not_found' })
      await expect(store.download(ownerId, attachId)).resolves.toEqual({
        storageKey: `agent-attachments/${attachId}`, name: '设计稿', ext: 'txt', mime: 'text/plain', size: 14,
      })
      expect(await admission.prepare(ownerId, input)).toMatchObject({ identity: first.identity, userMessageId: first.userMessageId, replay: true })
      await expect(runtime.db.transaction().execute(tx => claimDesktopChatAttachments(tx, ownerId, first.userMessageId + 1, [attachId])))
        .rejects.toMatchObject({ code: 'not_found' })
    } finally { await runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('录音转写可单独发送并随附件进入会话历史和模型上下文', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-desktop-voice-'))
  const path = join(directory, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const session = await runtime.db.transaction().execute(tx => createDesktopAgentSession(tx, ownerId, '录音会话'))
      const attachId = '0123456789abcdef0123456789abcdef'
      const transcript = '请把例会移到周五'
      await createDesktopChatAttachmentStore(runtime.db).stage(ownerId, {
        attachId, name: '录音', ext: 'wav', mime: 'audio/wav', size: 48, voice: true, transcript,
      })
      const { identity } = await createSqliteAgentAdmission(runtime.db).prepare(ownerId, {
        session_id: session.id, message: '', attachments: [attachId],
      })
      expect(await readDesktopAgentMessages(runtime.db, ownerId, session.id))
        .toMatchObject([{ files: [{ attach_id: attachId, kind: 'voice', transcript }] }])
      const source = createSqliteAgentSessionSource(runtime.db)
      expect(await source.currentTurn(identity))
        .toMatchObject({ currentUser: { message: { content: `语音转写：${transcript}` }, files: [{ transcript }] } })
      const { rows } = await source.historyReader.read({ ...identity, runId: 'follow-up' })
      const restored = restoreHistoryForRequest(rows[0]!, { userTimezone: 'UTC', formatMessageTime: () => '测试时间' })
      expect(restored).not.toBeNull()
      expect(renderOpenaiHistory([restored!])).toMatchObject([{
        role: 'user', content: expect.arrayContaining([{ type: 'text', text: `语音转写：${transcript}` }]),
      }])
    } finally { await runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('仅图片可发送，其他无文字附件被拒绝后仍可继续编辑草稿', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-desktop-image-'))
  const path = join(directory, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const session = await runtime.db.transaction().execute(tx => createDesktopAgentSession(tx, ownerId, '图片会话'))
      const store = createDesktopChatAttachmentStore(runtime.db)
      const admission = createSqliteAgentAdmission(runtime.db)
      const videoId = '0123456789abcdef0123456789abcdef'
      await store.stage(ownerId, { attachId: videoId, name: '视频', ext: 'mp4', mime: 'video/mp4', size: 48, voice: false })
      await expect(admission.prepare(ownerId, { session_id: session.id, message: '', attachments: [videoId] }))
        .rejects.toMatchObject({ code: 'invalid_request' })
      expect(await readDesktopAgentMessages(runtime.db, ownerId, session.id)).toHaveLength(0)
      expect(await store.deleteDraft(ownerId, videoId)).toBe(`agent-attachments/${videoId}`)

      const attachId = 'ffeeddccbbaa99887766554433221100'
      await store.stage(ownerId, { attachId, name: '图片', ext: 'png', mime: 'image/png', size: 48, voice: false })
      const { identity } = await admission.prepare(ownerId, { session_id: session.id, message: '', attachments: [attachId] })
      expect(await readDesktopAgentMessages(runtime.db, ownerId, session.id))
        .toMatchObject([{ text: '', files: [{ attach_id: attachId, kind: 'image' }] }])
      expect(await createSqliteAgentSessionSource(runtime.db).currentTurn(identity))
        .toMatchObject({ currentUser: { message: { content: expect.stringContaining(attachId) } } })
    } finally { await runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
