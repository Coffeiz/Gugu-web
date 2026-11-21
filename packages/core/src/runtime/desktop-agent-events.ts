import type { Kysely } from 'kysely'
import type { Database } from '../data/schema.js'
import { CoreError } from '../contracts/index.js'
import { MAX_AGENT_RESPONSE, type DesktopAgentEventPage } from '../contracts/desktop.js'
import { reconstructionStatusEvent, startupFailureEvent } from '../agent/run/event-stream.js'
import { projectAgentRunEvent } from '../agent/run/event-projection.js'
import { createSqliteAgentAdmission } from '../agent/run/sqlite-admission.js'
import { createSqliteAgentRunCoordination } from '../agent/run/sqlite-coordination.js'
import { loadSqliteAgentRunSecret } from '../agent/run/sqlite-secret.js'
import { createSqliteAgentRunStore } from '../agent/run/sqlite-store.js'
import { settleClosedSqliteInteraction } from '../agent/run/sqlite-recovery.js'
import { createSqliteInteractionProjection } from '../agent/interactions/sqlite-projection.js'

/** 宿主可按运行和游标补读已提交的展示事件。 */
export function createDesktopAgentEventReader(db: Kysely<Database>, databasePath: string, ownerId: string) {
  const admission = createSqliteAgentAdmission(db)
  let reader: Awaited<ReturnType<typeof openReader>> | undefined
  async function openReader() {
    const secret = await loadSqliteAgentRunSecret(db, databasePath)
    const store = createSqliteAgentRunStore(db, secret, {
      async writeHistory() { throw new Error('事件读取端口不能写入历史') },
    })
    return { store, readState: createSqliteAgentRunCoordination(db, store).readState,
      projection: createSqliteInteractionProjection(db, secret) }
  }
  return async (sessionId: number, runId: string | undefined, after: number, stateOnly = false, imDelivery = false, imStream = false): Promise<DesktopAgentEventPage> => {
    if (runId === undefined && after !== 0) throw new CoreError('invalid_request', '续读事件必须指定运行')
    const active = await admission.active(ownerId, sessionId, runId)
    if (!active || (runId !== undefined && !active.identity)) throw new CoreError('not_found', '会话或运行不存在')
    const identity = active.identity
    if (!identity) return { runId: null, events: [], cursor: 0, status: 'idle', hasMore: false,
      ...(stateOnly ? { executionState: active.executionState } : {}) }
    await settleClosedSqliteInteraction(db, databasePath, identity)
    const { store, readState, projection } = reader ??= await openReader()
    if (stateOnly) {
      const state = await readState(identity)
      return { runId: identity.runId, executionState: active.executionState, status: state?.status ?? 'preparing',
        events: [], cursor: state?.sequence ?? 0, hasMore: false }
    }
    const events: DesktopAgentEventPage['events'] = []
    let cursor = after
    let size = 0
    const saved = await store.readEventsAfter(identity, after)
    for (const event of saved) {
      const projected: DesktopAgentEventPage['events'] = await projectAgentRunEvent(event, projection)
      if (imDelivery) {
        if (event.type === 'round_end' && typeof event.payload.text === 'string')
          projected.push({ type: 'im_round_end', sequence: event.sequence, text: event.payload.text })
        else if (event.type === 'tool_call') projected.push({ type: 'im_round_continues' })
        else if (event.type === 'final' && event.payload.status === 'completed' && typeof event.payload.text === 'string')
          projected.push({ type: 'im_final_text', text: event.payload.text })
      }
      if (imStream && ['token', 'tool_call', 'tool_done', 'round_end', 'final', 'interaction_required', 'interaction_resolved', 'run_resumed'].includes(event.type)) {
        const { text, status } = event.payload
        projected.push({ type: 'im_stream', runEvent: {
          id: event.id, identity: event.identity, sequence: event.sequence, round: event.round, type: event.type,
          payload: { ...(['token', 'round_end', 'final'].includes(event.type) && typeof text === 'string' ? { text } : {}),
            ...(event.type === 'final' && typeof status === 'string' ? { status } : {}) },
        } })
      }
      const bytes = Buffer.byteLength(JSON.stringify(projected))
      if (size + bytes > MAX_AGENT_RESPONSE - 512) {
        if (cursor === after) throw new CoreError('storage_error', '运行事件超出桌面协议限制')
        break
      }
      events.push(...projected)
      size += bytes
      cursor = event.sequence
    }
    const state = await readState(identity)
    const hasMore = (state?.sequence ?? 0) > cursor
    if (!hasMore) {
      const reconstruction = reconstructionStatusEvent(identity, cursor, state?.status)
      if (reconstruction) events.push(...await projectAgentRunEvent(reconstruction, projection))
      else if (state?.status === 'startup_failed')
        events.push(...await projectAgentRunEvent(startupFailureEvent(identity, cursor), projection))
    }
    return { runId: identity.runId, events, cursor, status: state?.status ?? 'preparing', hasMore }
  }
}
