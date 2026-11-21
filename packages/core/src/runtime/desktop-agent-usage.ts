import { sql, type Kysely } from 'kysely'
import { dataContext } from '../contracts/index.js'
import type { Database } from '../data/schema.js'
import { databaseTime, utc } from '../data/codec.js'
import { addUtcDaysToDateKey, dateKeyInTimeZone, startOfDateKeyInTimeZone } from '../shared/date-time.js'
import { createAgentRunCodec } from '../agent/run/codec.js'
import { loadSqliteAgentRunSecret } from '../agent/run/sqlite-secret.js'

export async function readDesktopAgentUsage(db: Kysely<Database>, databasePath: string, ownerId: string) {
  const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const today = dateKeyInTimeZone(new Date(), timezone)
  const start = addUtcDaysToDateKey(today, -29)
  const days = Array.from({ length: 30 }, (_, index) => addUtcDaysToDateKey(start, index))
  const byDay = new Map(days.map(day => [day, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }]))
  const since = databaseTime(startOfDateKeyInTimeZone(start, timezone).toISOString(), 'sqlite')
  const { rows } = await sql<{ session_id: number; run_id: string; sequence: number; event_id: string;
    nonce: Uint8Array; payload: Uint8Array; created_at: string }>`
    SELECT a.session_id,a.run_id,e.sequence,e.event_id,e.nonce,e.payload,m.created_at
    FROM agent_run_admissions a
    JOIN conversation_messages m ON m.id=a.user_message_id
    JOIN agent_run_checkpoints c ON c.user_id=a.user_id AND c.session_id=a.session_id AND c.run_id=a.run_id
    JOIN agent_run_events e ON e.user_id=c.user_id AND e.session_id=c.session_id
      AND e.run_id=c.run_id AND e.sequence=c.sequence
    WHERE a.user_id=${owner} AND m.created_at>=${since}
      AND c.status IN ('completed','failed','cancelled')
  `.execute(db)
  if (rows.length) {
    const codec = createAgentRunCodec(await loadSqliteAgentRunSecret(db, databasePath))
    for (const row of rows) {
      const day = byDay.get(dateKeyInTimeZone(new Date(utc(row.created_at).replace(' ', 'T')), timezone))
      if (!day) continue
      const identity = { ownerId, sessionId: String(row.session_id), runId: row.run_id }
      const event = codec.decryptEvent(identity, row.event_id, row.sequence, row.nonce, row.payload)
      if (event.type !== 'final') continue
      const usage = event.payload.usage
      if (!usage || typeof usage !== 'object') continue
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
        const value = (usage as Record<string, unknown>)[key]
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) day[key] += value
      }
    }
  }
  const values = [...byDay.values()]
  return {
    labels: days.map(day => day.slice(5).replace('-', '/')),
    tokens_in: values.map(day => day.input),
    tokens_out: values.map(day => day.output),
    cache_read: values.map(day => day.cacheRead),
    cache_write: values.map(day => day.cacheWrite),
  }
}
