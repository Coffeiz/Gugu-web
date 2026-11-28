import { setTimeout as delay } from 'node:timers/promises'
import { createPostgresInboundStore } from './postgres-inbound-store.js'
import type { Pool } from 'pg'
import type { GatewayInbox, ImInboundConsumption } from '@gugu/gateway'
import { withPostgresTransaction } from '../../../../adapters/database/postgres-transaction.js'
import type { StreamQueue, RenewableMessageLeaseStore } from '../../../../workers/consumer.js'
import { createImInboundEnvelope } from './envelope.js'
import { NodeImInboxError, type NodeImBotBinding } from './inbox.js'

type Payload = Record<string, unknown>

export function createPostgresImInbox(pool: Pick<Pool, 'query' | 'connect'>, secretKey: string) {
  const store = createPostgresInboundStore(pool)
  const envelope = createImInboundEnvelope(secretKey)
  async function enqueue(binding: NodeImBotBinding, payload: Payload, client: Pick<Pool, 'query'> = pool): Promise<string | null> {
    const serialized = JSON.stringify(payload)
    if (Buffer.byteLength(serialized) > 1_048_576) throw new NodeImInboxError('invalid_input')
    const sealed = JSON.parse(serialized) as Payload
    if (envelope.openForWorker(binding, sealed).admission !== 'gateway') throw new NodeImInboxError('invalid_input')
    const result = await store.recordInbound({ ownerId: binding.ownerId, connectionId: binding.botId, platform: binding.platform,
      eventKey: String(sealed.message_id), groupId: sealed.chat_type === 'group' ? String(sealed.chat_id) : null, payload: serialized }, client)
    if (result.status === 'unbound') throw new NodeImInboxError('invalid_input')
    return result.status === 'queued' ? result.id : null
  }
  function telegram(binding: NodeImBotBinding, previous: Pick<GatewayInbox, 'cursor'>): GatewayInbox {
    if (binding.platform !== 'telegram') throw new NodeImInboxError('invalid_input')
    return {
      async cursor() {
        const result = await pool.query<{ update_id: string }>(
          'SELECT update_id FROM gugu_im_telegram_cursors WHERE user_id=$1 AND bot_id=$2', [binding.ownerId, binding.botId])
        return result.rows[0] ? Number(result.rows[0].update_id) : previous.cursor()
      },
      async commit(updateId, payload) {
        if (!Number.isSafeInteger(updateId) || updateId < 0) throw new TypeError('Telegram 事件 ID 无效')
        const sealed = payload ? envelope.sealAdmitted(binding, payload) : null
        await withPostgresTransaction(pool, async client => {
          const bot = await client.query(`SELECT 1 FROM user_bots
            WHERE user_id=$1 AND id=$2 AND platform='telegram' FOR SHARE`, [binding.ownerId, binding.botId])
          if (bot.rowCount !== 1) throw new NodeImInboxError('invalid_input')
          const advanced = await client.query(`INSERT INTO gugu_im_telegram_cursors (user_id,bot_id,update_id)
            VALUES ($1,$2,$3) ON CONFLICT (user_id,bot_id) DO UPDATE SET update_id=EXCLUDED.update_id
            WHERE gugu_im_telegram_cursors.update_id < EXCLUDED.update_id RETURNING update_id`,
          [binding.ownerId, binding.botId, updateId])
          if (advanced.rowCount && sealed) await enqueue(binding, sealed, client)
        })
      },
    }
  }
  function consume(signal: AbortSignal) {
    const queue: StreamQueue = {
      async claimStale() { return [] },
      async consume(count, blockMs) {
        const rows = await store.listClaimable(count)
        if (!rows.length) await delay(blockMs, undefined, { signal })
        return rows
      },
      // 唯一确认操作在 settleInbound 中执行。
      async acknowledge() {},
    }
    const stateKey = (messageId: string) => messageId.slice(messageId.indexOf('-') + 1)
    const leases: RenewableMessageLeaseStore = {
      claim: store.claimInbound,
      complete: store.settleInbound,
      renew: store.renewInbound,
    }
    return { queue, leases, stateKey, claimInbound: store.claimInbound, settleInbound: store.settleInbound }
  }
  return { enqueue, telegram, consume, clearCompletedPayloads: store.clearCompletedPayloads }
}
