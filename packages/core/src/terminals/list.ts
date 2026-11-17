import { sql, type Kysely } from 'kysely'
import { CoreError, dataContext } from '../contracts/index.js'
import { terminalPageAccess, type TerminalPageAccessSettings } from './metrics.js'

export const TERMINAL_RETENTION_DAYS = 30
export const AGENT_TERMINAL_KEEP_ALIVE = 5

export interface TerminalListRuntime extends Omit<TerminalPageAccessSettings, 'sandboxReady' | 'sandboxUnavailableReason'> {
  sandboxReady: boolean
  sandboxUnavailableReason?: string
  fullUserSandboxAuthorizationEnabled: boolean
}

export interface TerminalListItem {
  id: string
  name: string
  sessionId: number | null
  runId: string | null
  workspaceId: number | null
  source: string
  mode: string
  status: string
  shellMode: string
  networkProfile: string
  lastSequence: number
  outputChars: number
  ptyPid: number | null
  ptySandboxId: string | null
  ptyCols: number | null
  ptyRows: number | null
  createdAt: string
  updatedAt: string
  closedAt: string | null
}

export interface TerminalListResult {
  enabled: true
  ptyEnabled: boolean
  items: TerminalListItem[]
}

export interface TerminalRecordRow {
  id: string; name: string; session_id: number | null; run_id: string | null; workspace_id: number | null;
  source: string; mode: string | null; status: string; shell_mode: string; network_profile: string;
  last_sequence: number; output_chars: number; pty_pid: number | null; pty_sandbox_id: string | null;
  pty_cols: number | null; pty_rows: number | null; created_at: string | Date; updated_at: string | Date; closed_at: string | Date | null;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString().replace(/Z$/, '+00:00') : value
}

export function serializeTerminalRow(row: TerminalRecordRow, workspaceSupported = false): TerminalListItem {
  return {
    id: row.id, name: row.name, sessionId: row.session_id, runId: row.run_id,
    workspaceId: workspaceSupported ? row.workspace_id : null,
    source: row.source, mode: row.mode || 'agent-events', status: row.status,
    shellMode: row.shell_mode, networkProfile: row.network_profile,
    lastSequence: Number(row.last_sequence), outputChars: Number(row.output_chars),
    ptyPid: row.pty_pid, ptySandboxId: row.pty_sandbox_id, ptyCols: row.pty_cols, ptyRows: row.pty_rows,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), closedAt: row.closed_at === null ? null : iso(row.closed_at),
  }
}

/** Shared terminal page policy, retention cleanup, Agent cap, owner filtering and Python DTO. */
export function createTerminalListReader<DB>(
  db: Kysely<DB>,
  dialect: 'postgres' | 'sqlite',
  options: { now?: () => Date; workspaceSupported?: boolean } = {},
) {
  return async (rawOwnerId: string, input: { preferences: unknown; settings: TerminalListRuntime }): Promise<TerminalListResult> => {
    let ownerId: string
    try {
      const canonical = dataContext(rawOwnerId).ownerId
      ownerId = dialect === 'sqlite' ? canonical.replaceAll('-', '') : canonical
    }
    catch { throw new CoreError('invalid_request', '用户 ID 无效') }
    const access = terminalPageAccess(input.preferences, input.settings)
    if (!access.allowed) throw Object.assign(new Error(access.reason), { statusCode: 403 })

    const cutoffDate = new Date((options.now ?? (() => new Date()))().getTime() - TERMINAL_RETENTION_DAYS * 86_400_000)
    const cutoff = cutoffDate.toISOString()
    await db.transaction().execute(async tx => {
      const stale = await sql<{ id: string }>`
        SELECT id FROM terminal_sessions
        WHERE owner_id = ${ownerId} AND updated_at < ${cutoff}
          AND (closed_at IS NOT NULL OR (source = 'agent' AND session_id IS NULL))
      `.execute(tx)
      for (const row of stale.rows) {
        await sql`DELETE FROM terminal_events WHERE terminal_id = ${row.id}`.execute(tx)
        await sql`DELETE FROM terminal_sessions WHERE id = ${row.id} AND owner_id = ${ownerId}`.execute(tx)
      }

      const agents = await sql<{ id: string }>`
        SELECT id FROM terminal_sessions WHERE owner_id = ${ownerId} AND source = 'agent'
        ORDER BY updated_at DESC, id DESC
      `.execute(tx)
      for (const row of agents.rows.slice(AGENT_TERMINAL_KEEP_ALIVE)) {
        await sql`DELETE FROM terminal_events WHERE terminal_id = ${row.id}`.execute(tx)
        await sql`DELETE FROM terminal_sessions WHERE id = ${row.id} AND owner_id = ${ownerId}`.execute(tx)
      }
    })

    const result = await sql<TerminalRecordRow>`
      SELECT id,name,session_id,run_id,workspace_id,source,mode,status,shell_mode,network_profile,
        last_sequence,output_chars,pty_pid,pty_sandbox_id,pty_cols,pty_rows,created_at,updated_at,closed_at
      FROM terminal_sessions WHERE owner_id = ${ownerId} ORDER BY updated_at DESC,id DESC
    `.execute(db)

    return {
      enabled: true,
      ptyEnabled: input.settings.terminalMode !== 'pty_disabled' && input.settings.sandboxReady &&
        input.settings.fullUserSandboxAuthorizationEnabled,
      items: result.rows.map(row => serializeTerminalRow(row, options.workspaceSupported)),
    }
  }
}
