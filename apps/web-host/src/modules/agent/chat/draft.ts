import { timingSafeEqual } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { AgentChatInput } from './routes.js'

export class AgentQueueClaimConflict extends Error {
  constructor() { super('待发送队列认领冲突') }
}
type Item = Record<string, unknown>
type Row = { session_id: number | null; items: unknown }
const items = (value: unknown): Item[] => Array.isArray(value) ? value.filter((v): v is Item => !!v && typeof v === 'object' && !Array.isArray(v)) : []
function sameToken(left: unknown, right: string): boolean {
  const a = Buffer.from(String(left)), b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
async function locked(client: PoolClient, owner: string, id: string): Promise<Row | undefined> {
  return (await client.query<Row>('SELECT session_id, items FROM conversation_pending_queues WHERE user_id=$1 AND queue_id=$2 FOR UPDATE', [owner, id])).rows[0]
}

/** 由聊天准备调用，复用调用方事务，冲突必须中止用户消息提交。 */
export async function bindAgentChatPendingQueue(client: PoolClient, owner: string, sessionId: number, isNew: boolean, input: AgentChatInput): Promise<void> {
  const id = input.pending_queue_id, key = input.pending_queue_item_key, token = input.pending_queue_claim_token
  if (!id) { if (key != null) throw new AgentQueueClaimConflict(); return }
  const session = await client.query('SELECT id FROM conversation_sessions WHERE id=$1 AND user_id=$2', [sessionId, owner])
  if (!session.rowCount) throw new AgentQueueClaimConflict()
  const canonical = `session-${sessionId}`
  if (isNew) {
    const draft = await locked(client, owner, id)
    if (draft) {
      if (draft.session_id !== null) throw new AgentQueueClaimConflict()
      const additions = items(draft.items)
      if (additions.length) {
        await client.query("INSERT INTO conversation_pending_queues(user_id,queue_id,session_id,items,updated_at) VALUES ($1,$2,$3,'[]'::jsonb,now()) ON CONFLICT (user_id,queue_id) DO NOTHING", [owner, canonical, sessionId])
        const target = await locked(client, owner, canonical)
        if (!target) throw new Error('队列创建失败')
        const merged = new Map<unknown, Item>()
        for (const item of [...items(target.items), ...additions]) merged.set(item.key, item)
        await client.query('UPDATE conversation_pending_queues SET session_id=$3,items=$4::jsonb,updated_at=now() WHERE user_id=$1 AND queue_id=$2', [owner, canonical, sessionId, JSON.stringify([...merged.values()])])
      }
      await client.query('DELETE FROM conversation_pending_queues WHERE user_id=$1 AND queue_id=$2', [owner, id])
    }
  }
  if (key == null) return
  if (id !== canonical) throw new AgentQueueClaimConflict()
  const row = await locked(client, owner, canonical)
  if (!row) throw new AgentQueueClaimConflict()
  const all = items(row.items), matching = all.find(item => item.key === key)
  if (!matching) throw new AgentQueueClaimConflict()
  const stored = matching._claim_token
  if (stored && (!token || !sameToken(stored, token)) || token && (!stored || !sameToken(stored, token))) throw new AgentQueueClaimConflict()
  const remaining = all.filter(item => item.key !== key)
  if (!remaining.length) await client.query('DELETE FROM conversation_pending_queues WHERE user_id=$1 AND queue_id=$2', [owner, canonical])
  else await client.query('UPDATE conversation_pending_queues SET session_id=$3,items=$4::jsonb,updated_at=now() WHERE user_id=$1 AND queue_id=$2', [owner, canonical, sessionId, JSON.stringify(remaining)])
}
