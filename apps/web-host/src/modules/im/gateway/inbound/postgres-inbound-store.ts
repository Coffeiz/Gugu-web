import type { Pool } from 'pg'
import type { InboundStorageKey, InboundRecordResult } from '@gugu/core/im/inbound-store'

type QueueRow = { id: string; payload: Record<string, unknown> }

export function createPostgresInboundStore(pool: Pick<Pool, 'query'>) {
  async function recordInbound(input: InboundStorageKey & { groupId: string | null; payload: string },
    client: Pick<Pool, 'query'> = pool): Promise<InboundRecordResult> {
    const result = await client.query<{ id: string | null; bound: boolean }>(`WITH bot AS MATERIALIZED (
        SELECT user_id,id,platform FROM user_bots WHERE user_id=$1 AND id=$2 AND platform=$3 FOR SHARE
      ), recorded AS (
        INSERT INTO gugu_im_inbound_queue (user_id,bot_id,platform,event_key,group_id,payload)
        SELECT user_id,id,platform,$4,$5,$6::jsonb FROM bot
        ON CONFLICT(user_id,bot_id,platform,event_key) DO NOTHING
        RETURNING received_ms || '-' || id AS id
      )
      SELECT (SELECT id FROM recorded) AS id, EXISTS(SELECT 1 FROM bot) AS bound`,
    [input.ownerId, input.connectionId, input.platform, input.eventKey, input.groupId, input.payload])
    const row = result.rows[0]
    if (!row?.bound) return { status: 'unbound' }
    return row.id ? { status: 'queued', id: row.id } : { status: 'duplicate' }
  }
  async function listClaimable(count: number): Promise<QueueRow[]> {
    const { rows } = await pool.query<QueueRow>(`SELECT received_ms || '-' || id AS id,payload
      FROM gugu_im_inbound_queue WHERE settled_at IS NULL
        AND (lease_until IS NULL OR lease_until <= clock_timestamp())
      ORDER BY id LIMIT $1`, [count])
    return rows
  }
  async function claimInbound(id: string, token: string, seconds: number): Promise<'claimed' | 'busy' | 'completed'> {
    const claimed = await pool.query(`UPDATE gugu_im_inbound_queue
      SET lease_token=$2,lease_until=clock_timestamp()+make_interval(secs=>$3)
      WHERE id=$1 AND settled_at IS NULL AND (lease_until IS NULL OR lease_until <= clock_timestamp())
      RETURNING id`, [id, token, seconds])
    if (claimed.rowCount === 1) return 'claimed'
    const row = await pool.query<{ settled: boolean }>('SELECT settled_at IS NOT NULL AS settled FROM gugu_im_inbound_queue WHERE id=$1', [id])
    return row.rows[0]?.settled ? 'completed' : 'busy'
  }

  async function settleInbound(id: string, token: string) {
    const result = await pool.query(`UPDATE gugu_im_inbound_queue
      SET settled_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
      WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp() AND settled_at IS NULL`, [id, token])
    return result.rowCount === 1
  }
  async function renewInbound(id: string, token: string, seconds: number) {
    const result = await pool.query(`UPDATE gugu_im_inbound_queue
      SET lease_until=clock_timestamp()+make_interval(secs=>$3)
      WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp() AND settled_at IS NULL`, [id, token, seconds])
    return result.rowCount === 1
  }
  async function clearCompletedPayloads() {
    await pool.query(`UPDATE gugu_im_inbound_queue SET payload=NULL,group_id=NULL WHERE id IN (
      SELECT id FROM gugu_im_inbound_queue WHERE settled_at<clock_timestamp()-interval '30 minutes'
        AND payload IS NOT NULL ORDER BY settled_at LIMIT 1000)`)
  }
  return { recordInbound, listClaimable, claimInbound, settleInbound, renewInbound, clearCompletedPayloads }
}
