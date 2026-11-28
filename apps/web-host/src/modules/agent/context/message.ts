import { parseAgentCommand } from '@gugu/core/agent/commands/menu'
import type { CurrentTurnSources, Json, RunIdentity } from '@gugu/core/agent'
import { resolveCurrentTurnTextAttachments } from '@gugu/core/agent'
import type { Pool } from 'pg'
import type { OwnedCurrentMessage } from './source.js'
import { createCurrentMessageAttachmentReader, type CurrentMessageAttachmentReaderOptions } from './attachments.js'

/** 当前 Web 消息尚不支持附件媒体与需要专用命令处理器的输入。 */
export class UnsupportedWebAgentMessageError extends Error {
  constructor(readonly reason: 'attachment' | 'command' | 'content') {
    super(reason === 'attachment' ? '当前运行暂不支持附件，请移除附件后重试。' : reason === 'command' ? '当前运行暂不支持该命令。' : '当前消息内容暂不支持恢复。')
  }
}

/** 快照只读取服务端发送事务写入的消息，调用方提供的消息字段不作为引用来源。 */
export function createWebCurrentMessageMaterializer(pool: Pick<Pool, 'query'>, attachmentOptions?: Omit<CurrentMessageAttachmentReaderOptions, 'pool'>) {
  const readAttachments = attachmentOptions ? createCurrentMessageAttachmentReader({ pool, ...attachmentOptions }) : null
  return async (identity: RunIdentity, message: OwnedCurrentMessage, signal?: AbortSignal): Promise<CurrentTurnSources> => {
    signal?.throwIfAborted()
    if (!identity.ownerId || !identity.sessionId || !identity.runId || !/^[1-9]\d*$/.test(message.id) || typeof message.content !== 'string') throw new Error('当前消息身份无效')
    const result = await pool.query<{ content: string; content_json: unknown; files: unknown; references_json: unknown }>(`SELECT m.content,m.content_json,m.files,m.references_json FROM conversation_messages m
      JOIN conversation_sessions s ON s.id=m.session_id WHERE s.user_id=$1 AND s.id=$2 AND m.id=$3 AND m.role='user'`, [identity.ownerId, identity.sessionId, message.id])
    signal?.throwIfAborted()
    const stored = result.rows[0]
    if (!stored || typeof stored.content !== 'string') throw new Error('用户消息不存在')
    if (stored.files != null && !Array.isArray(stored.files)) throw new UnsupportedWebAgentMessageError('content')
    if (parseAgentCommand(stored.content)?.recognized) throw new UnsupportedWebAgentMessageError('command')
    if (stored.references_json != null && !Array.isArray(stored.references_json)) throw new UnsupportedWebAgentMessageError('content')
    const references = (stored.references_json ?? []) as unknown[]
    if (stored.content_json != null) {
      const blocks = stored.content_json
      if (!Array.isArray(blocks) || blocks.length !== 2 || !references.length
        || !blocks[0] || typeof blocks[0] !== 'object' || blocks[0].type !== 'knowledge-context' || blocks[0].scope !== 'explicit-reference' || typeof blocks[0].text !== 'string'
        || !blocks[1] || typeof blocks[1] !== 'object' || blocks[1].type !== 'text' || blocks[1].text !== stored.content)
        throw new UnsupportedWebAgentMessageError('content')
    }
    let rawText = stored.content
    let content: Json = stored.content_json != null ? stored.content_json as Json : stored.content
    const cards = Array.isArray(stored.files) ? stored.files : []
    if (cards.length) {
      if (!readAttachments) throw new UnsupportedWebAgentMessageError('attachment')
      const resolved = await readAttachments(identity.ownerId, message.id, cards)
      signal?.throwIfAborted()
      if (resolved.attachments.some(attachment => attachment.kind !== 'text')) throw new UnsupportedWebAgentMessageError('attachment')
      const materialized = await resolveCurrentTurnTextAttachments(stored.content, resolved.attachments, resolved.readText)
      rawText = materialized.rawText
      if (stored.content_json != null && Array.isArray(stored.content_json)) {
        const blocks = structuredClone(stored.content_json) as Array<Record<string, unknown>>
        const textBlock = blocks[1]
        if (textBlock && textBlock.type === 'text' && textBlock.text === stored.content) textBlock.text = rawText
        content = blocks as Json
      } else content = rawText
    }
    return { currentUser: { persistedMessageId: message.id, rawText, message: { role: 'user', content } } }
  }
}
