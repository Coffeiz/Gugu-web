import { sql, type Kysely } from 'kysely'
import { CoreError, dataContext } from '../contracts/index.js'
import { terminalPageAccess, type TerminalPageAccessSettings } from './metrics.js'
import { serializeTerminalRow, type TerminalListItem, type TerminalRecordRow } from './list.js'

export interface TerminalDetailRuntime extends Omit<TerminalPageAccessSettings, 'sandboxReady' | 'sandboxUnavailableReason'> {
  sandboxReady: boolean
  sandboxUnavailableReason?: string
}

/** Owner-scoped terminal detail with the same page and linked-session authorization as Python. */
export function createTerminalDetailReader<DB>(
  db: Kysely<DB>,
  dialect: 'postgres' | 'sqlite',
  options: { workspaceSupported?: boolean } = {},
) {
  return async (rawOwnerId: string, terminalId: string, input: { preferences: unknown; settings: TerminalDetailRuntime }): Promise<TerminalListItem> => {
    let ownerId: string
    try {
      const canonical = dataContext(rawOwnerId).ownerId
      ownerId = dialect === 'sqlite' ? canonical.replaceAll('-', '') : canonical
    } catch { throw new CoreError('invalid_request', '用户 ID 无效') }

    const row = (await sql<TerminalRecordRow>`
      SELECT id,name,session_id,run_id,workspace_id,source,mode,status,shell_mode,network_profile,
        last_sequence,output_chars,pty_pid,pty_sandbox_id,pty_cols,pty_rows,created_at,updated_at,closed_at
      FROM terminal_sessions WHERE owner_id = ${ownerId} AND id = ${terminalId}
    `.execute(db)).rows[0]
    if (!row) throw new CoreError('not_found', '终端不存在')

    if (row.session_id !== null) {
      const session = (await sql`SELECT id FROM conversation_sessions WHERE id = ${row.session_id} AND user_id = ${ownerId}`.execute(db)).rows[0]
      if (!session) throw Object.assign(new Error('终端会话不存在'), { statusCode: 403 })
    }
    const access = terminalPageAccess(input.preferences, input.settings)
    if (!access.allowed) throw Object.assign(new Error(access.reason), { statusCode: 403 })
    return serializeTerminalRow(row, options.workspaceSupported)
  }
}
