import { openAnchoredLocalFile } from '@gugu/fs/node'
import type { ToolDefinition } from '@gugu/core/tools'
import { z } from 'zod'
import { saveAgentDownload, agentDownloadsLimit } from '../../../agent/tools/files/downloads.js'
import { isOwnedFileStorageKey } from '../../../files/store.js'
import { createImRunScope } from './scope.js'

const schema = z.object({ attach_id: z.string().min(1).max(128) }).strict()
const unavailable = () => ({ kind: 'completed', successful: false, mutated: false, value: { error: '当前消息中的附件不可保存' } } as const)

export function createSaveImAttachmentTool(options: Parameters<typeof createImRunScope>[0] & { storageRoot: string }): ToolDefinition {
  const proof = createImRunScope(options)
  return {
    definition: { name: 'save_im_attachment', schema: { type: 'function', function: {
      name: 'save_im_attachment', description: '把当前 IM 私聊消息中的指定附件主动保存到个人文件的下载目录。',
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
      await authorize()
      const { rows: [row] } = await options.pool.query<{ storage_key: string; name: string; ext: string }>(
        `SELECT storage_key,name,ext FROM chat_attachments WHERE user_id=$1 AND attach_id=$2
         AND state='attached' AND message_id=ANY($3::integer[]) AND platform=$4`,
        [identity.ownerId, (input as z.infer<typeof schema>).attach_id, proof.ids, options.actor.platform],
      )
      if (!row || !isOwnedFileStorageKey(identity.ownerId, row.storage_key)) return unavailable()
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
