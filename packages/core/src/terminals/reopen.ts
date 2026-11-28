import { sql, type Kysely } from 'kysely'
import { CoreError, dataContext } from '../contracts/index.js'
import { terminalPageAccess, type TerminalPageAccessSettings } from './metrics.js'
import { serializeTerminalRow, type TerminalListItem, type TerminalRecordRow } from './list.js'

export interface TerminalReopenSettings extends TerminalPageAccessSettings {
  fullUserSandboxAuthorizationEnabled: boolean
}

/** Reopen an owner terminal view while retaining its output history and PTY metadata. */
export function createTerminalReopener<DB>(
  db: Kysely<DB>,
  dialect: 'postgres' | 'sqlite',
  publishUpdated: (ownerId: string, terminalId: string, origin: string | null) => Promise<unknown>,
  options: { now?: () => Date; workspaceSupported?: boolean } = {},
) {
  return async (rawOwnerId: string, terminalId: string, input: {
    preferences: unknown
    settings: TerminalReopenSettings
    ptyEnabled: boolean
    origin: string | null
  }): Promise<TerminalListItem> => {
    let ownerId: string
    try {
      const canonical = dataContext(rawOwnerId).ownerId
      ownerId = dialect === 'sqlite' ? canonical.replaceAll('-', '') : canonical
    } catch { throw new CoreError('invalid_request', '用户 ID 无效') }

    const access = terminalPageAccess(input.preferences, input.settings)
    if (!access.allowed) throw Object.assign(new Error(access.reason), { statusCode: 403 })

    let reopened: TerminalListItem | undefined
    await db.transaction().execute(async tx => {
      const row = (await sql<TerminalRecordRow>`
        SELECT id,name,session_id,run_id,workspace_id,source,mode,status,shell_mode,network_profile,
          last_sequence,output_chars,pty_pid,pty_sandbox_id,pty_cols,pty_rows,created_at,updated_at,closed_at
        FROM terminal_sessions WHERE owner_id=${ownerId} AND id=${terminalId}
      `.execute(tx)).rows[0]
      if (!row) throw new CoreError('not_found', '终端不存在')
      if (row.session_id !== null) {
        const session = (await sql`SELECT id FROM conversation_sessions WHERE id=${row.session_id} AND user_id=${ownerId}`.execute(tx)).rows[0]
        if (!session) throw Object.assign(new Error('终端会话不存在'), { statusCode: 403 })
      }
      if (row.mode === 'interactive-pty' && (
        input.settings.terminalMode === 'pty_disabled' ||
        !input.settings.fullUserSandboxAuthorizationEnabled || !input.ptyEnabled
      )) {
        const reason = input.settings.terminalMode === 'pty_disabled'
          ? '交互式 PTY 已由管理员关闭'
          : '完整用户沙箱授权已关闭，交互式 PTY 不可用'
        throw Object.assign(new Error(reason), { statusCode: 403 })
      }
      const updatedAt = (options.now ?? (() => new Date()))().toISOString().replace(/Z$/, '+00:00')
      const updated = (await sql<TerminalRecordRow>`
        UPDATE terminal_sessions SET status='idle',closed_at=NULL,updated_at=${updatedAt}
        WHERE owner_id=${ownerId} AND id=${terminalId}
        RETURNING id,name,session_id,run_id,workspace_id,source,mode,status,shell_mode,network_profile,
          last_sequence,output_chars,pty_pid,pty_sandbox_id,pty_cols,pty_rows,created_at,updated_at,closed_at
      `.execute(tx)).rows[0]
      if (!updated) throw new CoreError('not_found', '终端不存在')
      reopened = serializeTerminalRow(updated, options.workspaceSupported ?? false)
    })
    if (!reopened) throw new Error('终端重开事务没有返回结果')
    try { await publishUpdated(ownerId, terminalId, input.origin) } catch { /* 通知失败不回滚已提交的终端状态。 */ }
    return reopened
  }
}
