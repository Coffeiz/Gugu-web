import type { PoolClient } from 'pg'

/** 私有元数据只能传给受授权的媒体适配器；不可直接发送到客户端。 */
export interface AgentAttachmentMetadata {
  attach_id: string; name: string; ext: string; mime: string | null; size: string | number
  storage_key: string; kind: string; duration: number | null; img_width: number | null; img_height: number | null
  extra: Record<string, unknown> | null
}
export class AgentAttachmentClaimError extends Error {
  constructor() { super('附件已失效，请重新发送') }
}

/** 按用户查询，不可从调用方传入 storage_key；未找到的 ID 按现有聊天行为忽略。 */
export async function readOwnedChatAttachments(client: PoolClient, owner: string, ids: readonly string[]): Promise<AgentAttachmentMetadata[]> {
  if (!owner) throw new TypeError('用户身份无效')
  const unique = [...new Set(ids.filter(Boolean))]
  if (!unique.length) return []
  const result = await client.query<AgentAttachmentMetadata>(`SELECT attach_id,name,ext,mime,size,storage_key,kind,duration,img_width,img_height,extra
    FROM chat_attachments WHERE user_id=$1 AND attach_id = ANY($2::text[])`, [owner, unique])
  const byId = new Map(result.rows.map(row => [row.attach_id, row]))
  return ids.flatMap(id => { const row = byId.get(id); return row ? [row] : [] })
}

/** 只 claim 已解析的附件，任一失败都由调用方回滚消息与此前的 claim。 */
export async function claimOwnedChatAttachments(client: PoolClient, owner: string, messageId: number, ids: readonly string[]): Promise<void> {
  if (!owner || !Number.isSafeInteger(messageId) || messageId < 1) throw new TypeError('附件认领身份无效')
  for (const id of new Set(ids.filter(Boolean))) {
    const result = await client.query(`UPDATE chat_attachments SET state='attached',message_id=$3,attached_at=clock_timestamp()
      WHERE user_id=$1 AND attach_id=$2 AND state='draft'`, [owner, id, messageId])
    if (result.rowCount !== 1) throw new AgentAttachmentClaimError()
  }
}
