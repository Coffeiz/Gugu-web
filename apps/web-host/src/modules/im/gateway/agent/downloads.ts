import { openAnchoredLocalFile } from '@gugu/fs/node'
import type { ToolDefinition } from '@gugu/core/tools'
import { z } from 'zod'
import { saveAgentDownload, agentDownloadsLimit } from '../../../agent/tools/files/downloads.js'
import { isOwnedFilePath } from '../../../files/store.js'
import { imAttachmentScopeKey } from '../inbound/attachments.js'
import { imConversationScopeHash } from './identity.js'
import { createImRunScope } from './scope.js'

const schema = z.object({ attach_id: z.string().min(1).max(128) }).strict()
const unavailable = () => ({ kind: 'completed', successful: false, mutated: false, value: { error: '此附件不在当前私聊的可保存范围内或已失效' } } as const)

export function createImSaveAttachmentTool(options: Parameters<typeof createImRunScope>[0] & { storageRoot: string; ownerAttachment?: ToolDefinition }): ToolDefinition {
  const proof = createImRunScope(options)
  const scopeHash = imConversationScopeHash(options.secretKey, proof.binding, proof.payload)
  const attachmentScope = imAttachmentScopeKey(proof.scope)
  return {
    definition: { name: 'save_attachment', schema: { type: 'function', function: {
      name: 'save_attachment', description: '按 attach_id 把当前 IM 私聊里仍有效的附件保存到个人文件的下载目录，支持当前消息和同一私聊的历史消息。'
        + (options.ownerAttachment ? ' 已验证 owner 可凭精确 ID 保存其他会话的附件。' : ''),
      parameters: { type: 'object', additionalProperties: false, required: ['attach_id'], properties: {
        attach_id: { type: 'string', minLength: 1, maxLength: 128 },
      } },
    } } },
    effect: 'write',
    validate: input => schema.safeParse(input),
    async execute(input, scope, call) {
      const { identity, signal } = scope
      if (options.actor.role !== 'owner' || options.actor.chatType !== 'c2c'
        || identity.ownerId !== proof.identity.ownerId || identity.sessionId !== proof.identity.sessionId || identity.runId !== proof.identity.runId)
        return unavailable()
      const authorize = async () => {
        signal.throwIfAborted()
        await proof.read()
        return true
      }
      signal.throwIfAborted()
      const { watermark } = await proof.read()
      const { rows: [row] } = await options.pool.query<{ storage_key: string; name: string; ext: string }>(
        `SELECT a.storage_key,a.name,a.ext FROM chat_attachments a
         JOIN conversation_messages m ON m.id=a.message_id AND m.session_id=$3
         JOIN gugu_im_inbound_receipts r ON r.message_id=m.id AND r.session_id=m.session_id
           AND r.user_id=a.user_id AND r.run_id=m.run_id AND r.platform=a.platform
         WHERE a.user_id=$1 AND a.attach_id=$2 AND a.platform=$4 AND a.state='attached'
           AND a.extra->>'im_ingress_scope'=$5 AND r.scope_hash=$6
           AND r.state='dispatched' AND r.chat_type='c2c' AND r.bot_id=$7
           AND m.role='user' AND m.chat_type='c2c' AND m.conversation_seq<=$8`,
        [identity.ownerId, (input as z.infer<typeof schema>).attach_id, identity.sessionId, proof.scope.platform,
          attachmentScope, scopeHash, proof.scope.botId, watermark],
      )
      signal.throwIfAborted()
      if (!row && options.ownerAttachment && options.actor.verifiedOwner)
        return options.ownerAttachment.execute({ attach_id: (input as z.infer<typeof schema>).attach_id }, scope, call)
      if (!row || !isOwnedFilePath(identity.ownerId, row.storage_key)) return unavailable()
      const source = await openAnchoredLocalFile(options.storageRoot, row.storage_key)
      if (!source) return unavailable()
      try {
        if (source.size > agentDownloadsLimit) return unavailable()
        const name = row.ext && !row.name.toLowerCase().endsWith('.' + row.ext.toLowerCase()) ? `${row.name}.${row.ext}` : row.name
        return await saveAgentDownload(options.storageRoot, name, source.handle.createReadStream({ autoClose: false }), scope, call, authorize)
      } finally { await source.handle.close() }
    },
  }
}
