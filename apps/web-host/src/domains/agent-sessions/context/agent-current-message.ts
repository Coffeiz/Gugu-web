import type { CurrentTurnSources, Json, RunIdentity } from '@gugu/core/agent'
import type { Pool } from 'pg'
import type { OwnedCurrentMessage } from './agent-context-source.js'

/** 当前 Web 消息尚不支持附件媒体与需要专用命令处理器的输入。 */
export class UnsupportedWebAgentMessageError extends Error {
  constructor(readonly reason: 'attachment' | 'command' | 'content') {
    super(reason === 'attachment' ? '当前运行暂不支持附件，请移除附件后重试。' : reason === 'command' ? '当前运行暂不支持该命令。' : '当前消息内容暂不支持恢复。')
  }
}

const commands = new Set(['memory', 'mem', 'forget', 'compact', 'goal', 'new', 'workspace', 'auto', 'help', 'h'])
function isCommand(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/') && !trimmed.startsWith('／')) return false
  const name = trimmed.slice(1).trim().replaceAll('　', ' ').split(/\s+/, 1)[0]?.toLowerCase()
  return !!name && commands.has(name)
}

/** 快照只读取服务端发送事务写入的消息，调用方提供的消息字段不作为引用来源。 */
export function createWebCurrentMessageMaterializer(pool: Pick<Pool, 'query'>) {
  return async (identity: RunIdentity, message: OwnedCurrentMessage, signal?: AbortSignal): Promise<CurrentTurnSources> => {
    signal?.throwIfAborted()
    if (!identity.ownerId || !identity.sessionId || !identity.runId || !/^[1-9]\d*$/.test(message.id) || typeof message.content !== 'string') throw new Error('当前消息身份无效')
    const result = await pool.query<{ content: string; content_json: unknown; files: unknown; references_json: unknown }>(`SELECT m.content,m.content_json,m.files,m.references_json FROM conversation_messages m
      JOIN conversation_sessions s ON s.id=m.session_id WHERE s.user_id=$1 AND s.id=$2 AND m.id=$3 AND m.role='user'`, [identity.ownerId, identity.sessionId, message.id])
    signal?.throwIfAborted()
    const stored = result.rows[0]
    if (!stored || typeof stored.content !== 'string') throw new Error('用户消息不存在')
    if (stored.files != null && (!Array.isArray(stored.files) || stored.files.length)) throw new UnsupportedWebAgentMessageError('attachment')
    if (isCommand(stored.content)) throw new UnsupportedWebAgentMessageError('command')
    if (stored.references_json != null && !Array.isArray(stored.references_json)) throw new UnsupportedWebAgentMessageError('content')
    const references = (stored.references_json ?? []) as unknown[]
    if (stored.content_json != null) {
      const blocks = stored.content_json
      if (!Array.isArray(blocks) || blocks.length !== 2 || !references.length
        || !blocks[0] || typeof blocks[0] !== 'object' || blocks[0].type !== 'knowledge-context' || blocks[0].scope !== 'explicit-reference' || typeof blocks[0].text !== 'string'
        || !blocks[1] || typeof blocks[1] !== 'object' || blocks[1].type !== 'text' || blocks[1].text !== stored.content)
        throw new UnsupportedWebAgentMessageError('content')
    }
    return { currentUser: { persistedMessageId: message.id, rawText: stored.content, message: { role: 'user', content: stored.content_json != null ? stored.content_json as Json : stored.content } } }
  }
}
