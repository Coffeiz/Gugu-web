import type { Pool, PoolClient } from 'pg'
import type { AgentChatInput } from '../agent-chat-route.js'
import { resolveAgentChatReferences } from '../context/agent-references.js'
import { bindAgentChatPendingQueue } from './agent-chat-pending-queue.js'
import { claimOwnedChatAttachments, readOwnedChatAttachments } from './agent-chat-attachments.js'
import { createPostgresAgentChatPreparation, createPostgresWebChatSession } from './agent-chat-preparation.js'
import { enqueueAgentRunLocked } from './agent-run-dispatch-postgres.js'
import { registerAgentRunStartupLocked } from './agent-run-startup-postgres.js'

/**
 * Web 聊天的真实 PostgreSQL 准备链：会话、启动登记、消息、RAG job、附件认领、
 * 待发送队列和持久 dispatch 均复用同一事务。未找到或不属于当前 owner 的附件
 * 遵循 Python 聊天气泡行为先忽略；若已解析附件在 claim 时失效，整笔事务回滚。
 */
export function createPostgresWebAgentChatPreparation(
  pool: Pick<Pool, 'connect'>,
  options: { dispatchSecret: string; dispatchTtlSeconds: number },
) {
  if (!options.dispatchSecret) throw new TypeError('Agent dispatch 密钥未配置')
  if (!Number.isSafeInteger(options.dispatchTtlSeconds) || options.dispatchTtlSeconds < 1 || options.dispatchTtlSeconds > 604800)
    throw new RangeError('Agent dispatch 保存期限无效')

  return createPostgresAgentChatPreparation(pool, {
    createSession: createPostgresWebChatSession,
    registerStartup: registerAgentRunStartupLocked,
    async resolveAttachments(client: PoolClient, ownerId: string, input: AgentChatInput) {
      const rows = await readOwnedChatAttachments(client, ownerId, input.attachments ?? [])
      return {
        cards: rows.map(row => {
          const extra = row.extra ?? {}
          return {
            attach_id: row.attach_id,
            name: row.name,
            ext: row.ext,
            size_bytes: row.size,
            kind: row.kind,
            mime: row.mime,
            qq_face: extra.qq_face === true,
            quoted: extra.quoted === true,
            upload: true,
            duration: row.duration,
            img_width: row.img_width,
            img_height: row.img_height,
          }
        }),
        attachIds: rows.map(row => row.attach_id),
      }
    },
    resolveReferences: resolveAgentChatReferences,
    claimAttachments: claimOwnedChatAttachments,
    bindQueue: bindAgentChatPendingQueue,
    enqueueDispatch(client, identity, input, ttlSeconds) {
      return enqueueAgentRunLocked(client, options.dispatchSecret, identity, input, ttlSeconds)
    },
  })
}
