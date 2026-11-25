import { createHash } from 'node:crypto'
import { sql } from 'kysely'
import { openLocalFile } from '@gugu/fs/node'
import { dataContext } from '#core-source/contracts/index.js'
import type { RunIdentity } from '#core-source/agent/models.js'
import type { SqlDataRuntime } from '#core-source/data/runtime.js'
import { createImSendFileTool } from '#core-source/agent/tools/send-file.js'
import { createSaveAttachmentTool } from '#core-source/agent/tools/files.js'
import { desktopImAttachmentDelivery } from '#core-source/im/desktop-inbox.js'

type AttachmentScope = 'turn' | 'session' | 'owner'

export function createDesktopAttachmentTools(options: {
  db: SqlDataRuntime['db']
  interactive: boolean
  allowFilePath: boolean
  groupChat: boolean
  workspaceBinding: { directory_id?: unknown } | null
  authorize: (identity: RunIdentity) => Promise<boolean>
  attachmentScope: (identity: RunIdentity, signal: AbortSignal) => Promise<AttachmentScope>
  resolveOwnedAttachment: (identity: RunIdentity, id: string, signal: AbortSignal, scope: AttachmentScope) => Promise<{
    root: string; relativePath: string; name: string; size_bytes: number
  } | null>
  hostRequest: (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
  digest: (value: unknown) => string
}) {
  const { db, interactive, allowFilePath, groupChat, workspaceBinding, authorize,
    attachmentScope, resolveOwnedAttachment, hostRequest, digest } = options
  const sendFile = allowFilePath || groupChat ? createImSendFileTool({
    allowFilePath,
    async send({ identity, attachId, filePath, signal }) {
      const source = attachId ?? filePath
      if (!source || !await authorize(identity)) return 'failed'
      signal.throwIfAborted()
      const attempt = await desktopImAttachmentDelivery(db, identity, source, 'begin')
      if (!attempt) return 'failed'
      if (attempt.state !== 'new') return attempt.state === 'accepted' ? 'sent' : attempt.state === 'rejected' ? 'failed' : 'unknown'
      let outcome: 'accepted' | 'rejected' | 'unknown' = 'unknown'
      try {
        const result = await hostRequest('agent.im.sendAttachment', attempt, signal)
        if (result === 'accepted' || result === 'rejected') outcome = result
      } catch { /* 已占位的请求失去结果时保留未知。 */ }
      const receipt = await desktopImAttachmentDelivery(db, identity, source, outcome)
      return receipt?.state === 'accepted' ? 'sent' : receipt?.state === 'rejected' ? 'failed' : 'unknown'
    },
    async recover({ identity, attachId, filePath }) {
      const source = attachId ?? filePath
      if (!source || !await authorize(identity)) return 'unknown'
      const receipt = await desktopImAttachmentDelivery(db, identity, source, 'read')
      return receipt?.state === 'accepted' ? 'sent' : receipt?.state === 'rejected' ? 'failed' : 'unknown'
    },
  }) : undefined
  const saveAttachment = interactive ? createSaveAttachmentTool({
    async save(identity, input, roundId, call, signal) {
      signal.throwIfAborted()
      if (!await authorize(identity)) return { kind: 'failed', error: '附件保存授权已失效' }
      const workspaceDirectoryId = input.space === 'workspace' && workspaceBinding
        && typeof workspaceBinding.directory_id === 'string' ? workspaceBinding.directory_id : undefined
      if (input.space === 'workspace' && !workspaceDirectoryId)
        return { kind: 'failed', error: '当前会话没有绑定可写入的工作区，请先绑定工作区或保存到个人/项目文件' }
      const ids = input.source === 'latest'
        ? (await sql<{ attach_id: string }>`SELECT a.attach_id FROM chat_attachments a
            JOIN conversation_messages m ON m.id=a.message_id
            JOIN conversation_sessions s ON s.id=m.session_id AND s.user_id=a.user_id
            WHERE a.user_id=${dataContext(identity.ownerId).ownerId.replaceAll('-', '')}
              AND s.id=${Number(identity.sessionId)} AND a.state='attached'
            ORDER BY a.created_at DESC,a.attach_id DESC LIMIT 1`.execute(db)).rows.map(row => row.attach_id)
        : input.source === 'attach_ids' ? [...(input.attach_ids ?? [])] : [input.attach_id ?? '']
      if (input.source === 'latest' && ids.length === 0)
        return { kind: 'failed', error: '当前对话中没有可保存的近期附件' }
      const saved: Array<Record<string, unknown>> = []
      const failed: Array<{ attach_id: string; error: string }> = []
      const sourceScope = input.source === 'latest' ? 'session' : await attachmentScope(identity, signal)
      for (const attachId of ids) {
        signal.throwIfAborted()
        const attachment = await resolveOwnedAttachment(identity, attachId, signal, sourceScope)
        if (!attachment) {
          failed.push({ attach_id: attachId, error: '附件不存在或已过期' })
          continue
        }
        if (attachment.size_bytes > 32 * 1024 * 1024) {
          failed.push({ attach_id: attachId, error: '附件超过桌面文件库支持的 32 MB 上限' })
          continue
        }
        const opened = await openLocalFile(attachment.root, attachment.relativePath)
        if (!opened || opened.size !== attachment.size_bytes) {
          await opened?.handle.close()
          failed.push({ attach_id: attachId, error: '附件已过期或文件丢失' })
          continue
        }
        let bytes: Buffer
        try {
          bytes = await opened.handle.readFile()
          if (bytes.length !== attachment.size_bytes) {
            failed.push({ attach_id: attachId, error: '附件内容已变化' })
            continue
          }
        } finally { await opened.handle.close() }
        const expectedDigest = createHash('sha256').update(bytes).digest('hex')
        const projectId = input.space === 'project' ? input.project_id : undefined
        const operationId = digest(['agent.file.save_uploaded_file', identity.ownerId, identity.sessionId,
          identity.runId, roundId, call.id, attachId, input.space, projectId, workspaceDirectoryId])
        const fingerprint = digest([attachId, input.space, projectId ?? null, workspaceDirectoryId ?? null, input.folder_path ?? null,
          attachment.name, attachment.size_bytes, expectedDigest])
        try {
          const result: unknown = await hostRequest('agent.files.saveAttachment', {
            operationId, fingerprint, attachId, expectedSize: attachment.size_bytes, expectedDigest,
            name: attachment.name, space: input.space, ...(projectId === undefined ? {} : { projectId }),
            ...(workspaceDirectoryId === undefined ? {} : { workspaceDirectoryId }),
            ...(input.folder_path === undefined ? {} : { folderPath: input.folder_path }),
          }, signal)
          signal.throwIfAborted()
          if (!result || typeof result !== 'object' || Array.isArray(result)
            || typeof (result as Record<string, unknown>).name !== 'string'
            || typeof (result as Record<string, unknown>).path !== 'string'
            || (result as Record<string, unknown>).size_bytes !== attachment.size_bytes) {
            failed.push({ attach_id: attachId, error: '文件保存返回无效结果' })
            continue
          }
          saved.push({ attach_id: attachId, ...(result as Record<string, unknown>) })
        } catch {
          signal.throwIfAborted()
          failed.push({ attach_id: attachId, error: '附件保存失败，请确认目标目录仍可用' })
        }
      }
      if (input.source !== 'attach_ids') {
        const item = saved[0]
        if (!item) return { kind: 'failed', error: failed[0]?.error ?? '附件不存在或已过期' }
        const { attach_id: _attachId, size_bytes, ...value } = item
        return { kind: 'saved', mutated: item.replayed !== true, value: { ...value, size: size_bytes,
          ...(input.project_id ? { project_id: input.project_id } : {}) } }
      }
      return { kind: 'saved', mutated: saved.some(item => item.replayed !== true), value: {
        success: failed.length === 0, saved_count: saved.length, failed_count: failed.length,
        saved: saved.map(({ replayed: _replayed, ...item }) => item), failed,
      } }
    },
  }) : undefined
  return { sendFile, saveAttachment }
}
