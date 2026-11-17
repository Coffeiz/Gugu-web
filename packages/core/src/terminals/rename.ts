import { sql, type Kysely } from 'kysely'
import { CoreError, dataContext } from '../contracts/index.js'
import { terminalPageAccess, type TerminalPageAccessSettings } from './metrics.js'
import { serializeTerminalRow, type TerminalListItem, type TerminalRecordRow } from './list.js'

export interface TerminalRenameRuntime extends Omit<TerminalPageAccessSettings, 'sandboxReady' | 'sandboxUnavailableReason'> {
  sandboxReady: boolean
  sandboxUnavailableReason?: string
}

/** Owner-scoped rename transaction matching Python terminal rename and post-commit refresh. */
export function createTerminalRenamer<DB>(
  db: Kysely<DB>,
  dialect: 'postgres' | 'sqlite',
  publishChanged: (ownerId: string, terminalId: string, origin: string | null) => Promise<unknown>,
  options: { now?: () => Date; workspaceSupported?: boolean } = {},
) {
  return async (rawOwnerId: string, terminalId: string, input: {
    name: string; preferences: unknown; settings: TerminalRenameRuntime; origin: string | null
  }): Promise<TerminalListItem> => {
    let ownerId: string
    try {
      const canonical = dataContext(rawOwnerId).ownerId
      ownerId = dialect === 'sqlite' ? canonical.replaceAll('-', '') : canonical
    } catch { throw new CoreError('invalid_request', '用户 ID 无效') }
    let updated: TerminalRecordRow | undefined
    await db.transaction().execute(async tx => {
      const row = (await sql<{ id: string; session_id: number | null }>`
        SELECT id,session_id FROM terminal_sessions WHERE id = ${terminalId} AND owner_id = ${ownerId}
      `.execute(tx)).rows[0]
      if (!row) throw new CoreError('not_found', '终端不存在')
      if (row.session_id !== null) {
        const session = (await sql`SELECT id FROM conversation_sessions WHERE id = ${row.session_id} AND user_id = ${ownerId}`.execute(tx)).rows[0]
        if (!session) throw Object.assign(new Error('终端会话不存在'), { statusCode: 403 })
      }
      const access = terminalPageAccess(input.preferences, input.settings)
      if (!access.allowed) throw Object.assign(new Error(access.reason), { statusCode: 403 })
      const name = input.name.trim()
      if (!name) throw Object.assign(new Error('终端名称不能为空'), { statusCode: 400 })
      await sql`UPDATE terminal_sessions SET name = ${name.slice(0, 200)}, updated_at = ${(options.now ?? (() => new Date()))().toISOString().replace(/Z$/, '+00:00')} WHERE id = ${terminalId} AND owner_id = ${ownerId}`.execute(tx)
      updated = (await sql<TerminalRecordRow>`
        SELECT id,name,session_id,run_id,workspace_id,source,mode,status,shell_mode,network_profile,
          last_sequence,output_chars,pty_pid,pty_sandbox_id,pty_cols,pty_rows,created_at,updated_at,closed_at
        FROM terminal_sessions WHERE id = ${terminalId} AND owner_id = ${ownerId}
      `.execute(tx)).rows[0]
    })
    try { await publishChanged(dataContext(rawOwnerId).ownerId, terminalId, input.origin) }
    catch { /* Python commits the rename before publishing; a refresh failure does not roll it back. */ }
    return serializeTerminalRow(updated!, options.workspaceSupported)
  }
}
