import { sql, type Kysely } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { serializeTerminalRow, type TerminalRecordRow } from './list.js'

type Event = { kind: 'running'; command: string; runId: string } | {
  kind: 'result'; command: string; runId: string; stdout: string; stderr: string; exitCode: number | null; ok: boolean
}

/** 原子递增序号并提交事件，调用者应在提交后发布通知。 */
export function createTerminalEventAppender<DB>(db: Kysely<DB>, dialect: 'postgres' | 'sqlite', now = () => new Date(), includeSnapshot = false) {
  return async (rawOwner: string, terminalId: string, event: Event) => {
    const owner = dataContext(rawOwner).ownerId
    const ownerId = dialect === 'sqlite' ? owner.replaceAll('-', '') : owner
    const clean = (value: string) => value.replaceAll('\0', '\\0')
    const stdout = event.kind === 'running' ? 'running' : clean(event.stdout)
    const stderr = event.kind === 'running' ? '' : clean(event.stderr)
    const delta = event.kind === 'running' ? 0 : Array.from(stdout).length + Array.from(stderr).length
    const timestamp = now().toISOString()
    return db.transaction().execute(async tx => {
      const updated = await sql<{ last_sequence: number; output_chars: number }>`UPDATE terminal_sessions SET
        last_sequence=last_sequence+1, output_chars=output_chars+${delta}, updated_at=${timestamp},
        status=${event.kind === 'running' ? 'running' : event.ok ? 'idle' : 'failed'}
        WHERE id=${terminalId} AND owner_id=${ownerId} AND closed_at IS NULL RETURNING last_sequence,output_chars`.execute(tx)
      const state = updated.rows[0]
      if (!state) return null
      const sequence = Number(state.last_sequence)
      await sql`INSERT INTO terminal_events(terminal_id,run_id,sequence,event_type,source,command,stdout,stderr,exit_code,occurred_at)
        VALUES(${terminalId},${event.runId},${sequence},${event.kind === 'running' ? 'status' : 'command'},'user',${clean(event.command)},${stdout},${stderr},${event.kind === 'result' ? event.exitCode : null},${timestamp})`.execute(tx)
      if (event.kind === 'result' && Number(state.output_chars) > 500000) {
        const rows = await sql<{ id: number; stdout: string | null; stderr: string | null }>`SELECT id,stdout,stderr FROM terminal_events WHERE terminal_id=${terminalId} AND sequence<${sequence} ORDER BY sequence`.execute(tx)
        let remaining = Number(state.output_chars)
        for (const row of rows.rows) {
          if (remaining <= 500000) break
          await sql`DELETE FROM terminal_events WHERE id=${row.id} AND terminal_id=${terminalId}`.execute(tx)
          remaining -= Array.from(row.stdout ?? '').length + Array.from(row.stderr ?? '').length
        }
        await sql`UPDATE terminal_sessions SET output_chars=${remaining} WHERE id=${terminalId} AND owner_id=${ownerId}`.execute(tx)
      }
      const snapshot = includeSnapshot ? (await sql<TerminalRecordRow>`SELECT id,name,session_id,run_id,workspace_id,source,mode,status,shell_mode,network_profile,
        last_sequence,output_chars,pty_pid,pty_sandbox_id,pty_cols,pty_rows,created_at,updated_at,closed_at FROM terminal_sessions WHERE id=${terminalId} AND owner_id=${ownerId}`.execute(tx)).rows[0] : null
      if (includeSnapshot && !snapshot) throw new Error('终端快照不存在')
      return { sequence, type: event.kind === 'running' ? 'status' : 'command', source: 'user', runId: event.runId,
        command: clean(event.command), stdout, stderr, exitCode: event.kind === 'result' ? event.exitCode : null, occurredAt: timestamp,
        ...(snapshot ? { terminalSnapshot: serializeTerminalRow(snapshot, true) } : {}) }
    })
  }
}
