import { sql, type Kysely } from 'kysely'
import { CoreError, dataContext } from '../contracts/index.js'

export interface TerminalEventItem {
  sequence: number
  type: string
  source: string | null
  runId: string | null
  command: string | null
  stdout: string
  stderr: string
  exitCode: number | null
  occurredAt: string
}

export interface TerminalEventPage {
  events: TerminalEventItem[]
  closed: boolean
  lastSequence: number
}

interface TerminalEventRow {
  sequence: number | string
  event_type: string
  source: string | null
  run_id: string | null
  command: string | null
  stdout: string | null
  stderr: string | null
  exit_code: number | null
  occurred_at: string | Date
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString().replace(/Z$/, '+00:00') : value
}

/** Read persisted events after a cursor; Host owns polling cadence and SSE framing. */
export function createTerminalEventPageReader<DB>(db: Kysely<DB>, dialect: 'postgres' | 'sqlite') {
  return async (rawOwnerId: string, terminalId: string, after: number): Promise<TerminalEventPage | null> => {
    let ownerId: string
    try {
      const canonical = dataContext(rawOwnerId).ownerId
      ownerId = dialect === 'sqlite' ? canonical.replaceAll('-', '') : canonical
    } catch { throw new CoreError('invalid_request', '用户 ID 无效') }
    const terminal = (await sql<{ last_sequence: number | string; closed_at: string | Date | null }>`
      SELECT last_sequence,closed_at FROM terminal_sessions WHERE id = ${terminalId} AND owner_id = ${ownerId}
    `.execute(db)).rows[0]
    if (!terminal) return null
    const cursor = Number.isSafeInteger(after) ? Math.max(0, after) : 0
    const rows = await sql<TerminalEventRow>`
      SELECT sequence,event_type,source,run_id,command,stdout,stderr,exit_code,occurred_at
      FROM terminal_events WHERE terminal_id = ${terminalId} AND sequence > ${cursor}
      ORDER BY sequence ASC
    `.execute(db)
    return {
      events: rows.rows.map(row => ({
        sequence: Number(row.sequence), type: row.event_type, source: row.source, runId: row.run_id,
        command: row.command, stdout: row.stdout ?? '', stderr: row.stderr ?? '', exitCode: row.exit_code,
        occurredAt: iso(row.occurred_at),
      })),
      closed: terminal.closed_at !== null,
      lastSequence: Number(terminal.last_sequence),
    }
  }
}
