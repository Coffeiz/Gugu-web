import { setTimeout as delay } from 'node:timers/promises'
import type { Pool } from 'pg'
import type { GatewayInbox, ImInboundConsumption } from '@gugu/gateway'
import { withPostgresTransaction } from '../../../../adapters/database/postgres-transaction.js'
import type { InboundMessage, StreamQueue, RenewableMessageLeaseStore } from '../../../../workers/consumer.js'
import { createImInboundEnvelope } from './envelope.js'
import { NodeImInboxError, type NodeImBotBinding } from './inbox.js'

type Payload = Record<string, unknown>
type QueueRow = { id: string; payload: Payload }

export function createPostgresImInbox(pool: Pick<Pool, 'query' | 'connect'>, secretKey: string) {
  const envelope = createImInboundEnvelope(secretKey)
  async function enqueue(binding: NodeImBotBinding, payload: Payload, client: Pick<Pool, 'query'> = pool): Promise<string | null> {
    const serialized = JSON.stringify(payload)
    if (Buffer.byteLength(serialized) > 1_048_576) throw new NodeImInboxError('invalid_input')
    const sealed = JSON.parse(serialized) as Payload
    if (envelope.openForWorker(binding, sealed).admission !== 'gateway') throw new NodeImInboxError('invalid_input')
    const result = await client.query<{ id: string | null; bound: boolean }>(`WITH bot AS MATERIALIZED (
        SELECT user_id,id,platform FROM user_bots WHERE user_id=$1 AND id=$2 AND platform=$3 FOR SHARE
      ), recorded AS (
        INSERT INTO gugu_im_inbound_queue (user_id,bot_id,platform,event_key,group_id,payload)
        SELECT user_id,id,platform,$4,$5,$6::jsonb FROM bot
        ON CONFLICT(user_id,bot_id,platform,event_key) DO NOTHING
        RETURNING received_ms || '-' || id AS id
      )
      SELECT (SELECT id FROM recorded) AS id, EXISTS(SELECT 1 FROM bot) AS bound`,
    [binding.ownerId, binding.botId, binding.platform, sealed.message_id, sealed.chat_type === 'group' ? sealed.chat_id : null, serialized])
    const row = result.rows[0]
    if (!row?.bound) throw new NodeImInboxError('invalid_input')
    return row.id
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
    async function find(count: number): Promise<InboundMessage[]> {
      const { rows } = await pool.query<QueueRow>(`SELECT received_ms || '-' || id AS id,payload
        FROM gugu_im_inbound_queue WHERE settled_at IS NULL
          AND (lease_until IS NULL OR lease_until <= clock_timestamp())
        ORDER BY id LIMIT $1`, [count])
      return rows
    }
    const queue: StreamQueue = {
      async claimStale() { return [] },
      async consume(count, blockMs) {
        const rows = await find(count)
        if (!rows.length) await delay(blockMs, undefined, { signal })
        return rows
      },
      // 唯一确认操作在 settleInbound 中执行。
      async acknowledge() {},
    }
    const consumption: ImInboundConsumption<[string, string, number], 'claimed' | 'busy' | 'completed', [string, string], boolean> = {
      async claimInbound(id, token, seconds) {
        const claimed = await pool.query(`UPDATE gugu_im_inbound_queue
          SET lease_token=$2,lease_until=clock_timestamp()+make_interval(secs=>$3)
          WHERE id=$1 AND settled_at IS NULL AND (lease_until IS NULL OR lease_until <= clock_timestamp())
          RETURNING id`, [id, token, seconds])
        if (claimed.rowCount === 1) return 'claimed'
        const row = await pool.query<{ settled: boolean }>('SELECT settled_at IS NOT NULL AS settled FROM gugu_im_inbound_queue WHERE id=$1', [id])
        return row.rows[0]?.settled ? 'completed' : 'busy'
      },
      async settleInbound(id, token) {
        const result = await pool.query(`UPDATE gugu_im_inbound_queue
          SET settled_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
          WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp() AND settled_at IS NULL`, [id, token])
        return result.rowCount === 1
      },
    }
    const stateKey = (messageId: string) => messageId.slice(messageId.indexOf('-') + 1)
    const leases: RenewableMessageLeaseStore = {
      claim: consumption.claimInbound,
      complete: consumption.settleInbound,
      async renew(id, token, seconds) {
        const result = await pool.query(`UPDATE gugu_im_inbound_queue
          SET lease_until=clock_timestamp()+make_interval(secs=>$3)
          WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp() AND settled_at IS NULL`, [id, token, seconds])
        return result.rowCount === 1
      },
    }
    return { queue, leases, stateKey, ...consumption }
  }
  async function clearCompletedPayloads() {
    await pool.query(`UPDATE gugu_im_inbound_queue SET payload=NULL,group_id=NULL WHERE id IN (
      SELECT id FROM gugu_im_inbound_queue WHERE settled_at<clock_timestamp()-interval '30 minutes'
        AND payload IS NOT NULL ORDER BY settled_at LIMIT 1000)`)
  }
  return { enqueue, telegram, consume, clearCompletedPayloads }
}
