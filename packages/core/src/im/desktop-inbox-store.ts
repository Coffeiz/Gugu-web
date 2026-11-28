import { sql, type Kysely } from 'kysely'
import type { Database } from '../data/schema.js'
import type { InboundStorageKey, InboundRecordResult } from './inbound-store.js'

type Connection = Omit<InboundStorageKey, 'eventKey'>

export function createSqliteInboundStore(tx: Kysely<Database>) {
  async function recordInbound({ ownerId: owner, platform, connectionId, eventKey, clientId, payload }:
    InboundStorageKey & { clientId: string; payload: Buffer }): Promise<InboundRecordResult> {
    const recorded = await sql`SELECT 1 FROM desktop_im_sessions im JOIN conversation_messages m ON m.session_id=im.session_id
      WHERE im.owner_id=${owner} AND im.platform=${platform} AND im.connection_id=${connectionId}
        AND m.client_message_id=${clientId}`.execute(tx)
    if (recorded.rows.length) return { status: 'duplicate' }
    const inserted = await tx.insertInto('desktop_im_inbox').values({
      owner_id: owner, platform, connection_id: connectionId, event_key: eventKey,
      sealed_event: payload, received_at: new Date().toISOString(),
    }).onConflict(conflict => conflict.columns(['owner_id', 'platform', 'connection_id', 'event_key']).doNothing())
      .returning('event_key').executeTakeFirst()
    return inserted ? { status: 'queued', id: eventKey } : { status: 'duplicate' }
  }

  async function readHead({ ownerId: owner, platform, connectionId }: Connection, state: 'pending' | 'running') {
    const entry = await tx.selectFrom('desktop_im_inbox').select(['event_key', 'sealed_event', 'run_id', 'session_id'])
      .where('owner_id', '=', owner).where('platform', '=', platform)
      .where('connection_id', '=', connectionId).where('state', '=', state)
      .orderBy('received_at').orderBy(sql`rowid`).limit(1).executeTakeFirst()
    return entry ?? null
  }

  const claimInbound = (connection: Connection) => readHead(connection, 'pending')
  const resumeDelivery = (connection: Connection) => readHead(connection, 'running')

  /** Run 准入已提交。保留收件密文，以便独立恢复后续回复。 */
  async function settleInbound({ ownerId: owner, platform, connectionId, eventKey, sessionId, runId }:
    InboundStorageKey & { sessionId: number; runId: string }) {
    await tx.updateTable('desktop_im_inbox').set({ session_id: sessionId, run_id: runId, state: 'running' })
      .where('owner_id', '=', owner).where('platform', '=', platform).where('connection_id', '=', connectionId)
      .where('event_key', '=', eventKey).where('state', '=', 'pending').execute()
  }

  async function completeDelivery({ ownerId: owner, platform, connectionId, eventKey, runId }:
    InboundStorageKey & { runId: string }) {
    await tx.updateTable('desktop_im_inbox').set({ state: 'completed' })
      .where('owner_id', '=', owner).where('platform', '=', platform).where('connection_id', '=', connectionId)
      .where('event_key', '=', eventKey).where('run_id', '=', runId).where('state', '=', 'running').execute()
  }

  return { recordInbound, claimInbound, settleInbound, resumeDelivery, completeDelivery }
}
