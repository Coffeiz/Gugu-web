import { randomUUID } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import { CoreError, dataContext } from '../contracts/index.js'
import { terminalPageAccess, type TerminalPageAccessSettings } from './metrics.js'
import { serializeTerminalRow, type TerminalListItem, type TerminalRecordRow } from './list.js'

export interface TerminalCreateAccessSettings extends TerminalPageAccessSettings {
  fullUserSandboxAuthorizationEnabled: boolean
}

/** Owner-scoped creation transaction for user terminal views. */
export function createTerminalCreator<DB>(
  db: Kysely<DB>,
  dialect: 'postgres' | 'sqlite',
  publishCreated: (ownerId: string, terminalId: string, origin: string | null) => Promise<unknown>,
  options: { now?: () => Date; id?: () => string; workspaceSupported?: boolean } = {},
) {
  return async (rawOwnerId: string, input: {
    name: string
    sessionId: number | null
    workspaceId: number | null
    mode: 'agent-events' | 'interactive-pty'
    preferences: unknown
    settings: TerminalCreateAccessSettings
    ptyEnabled: boolean
    origin: string | null
  }): Promise<TerminalListItem> => {
    let ownerId: string
    try {
      const canonical = dataContext(rawOwnerId).ownerId
      ownerId = dialect === 'sqlite' ? canonical.replaceAll('-', '') : canonical
    } catch { throw new CoreError('invalid_request', '用户 ID 无效') }
    if (!['agent-events', 'interactive-pty'].includes(input.mode)) throw new CoreError('invalid_request', '终端模式无效')
    const access = terminalPageAccess(input.preferences, input.settings)
    if (!access.allowed) throw Object.assign(new Error(access.reason), { statusCode: 403 })
    if (input.mode === 'interactive-pty') {
      if (input.settings.terminalMode === 'pty_disabled')
        throw Object.assign(new Error('交互式 PTY 已由管理员关闭'), { statusCode: 403 })
      if (!input.settings.fullUserSandboxAuthorizationEnabled || !input.ptyEnabled)
        throw Object.assign(new Error('完整用户沙箱授权已关闭，交互式 PTY 不可用'), { statusCode: 403 })
    }
    if (input.workspaceId !== null && !options.workspaceSupported)
      throw Object.assign(new Error('OSS 存储模式不支持 workspace，请使用独立 Shell 沙盒'), { statusCode: 409 })

    const id = options.id?.() ?? `term-${randomUUID().replaceAll('-', '')}`
    const name = (input.name || '终端').trim().slice(0, 200) || '终端'
    const occurredAt = (options.now ?? (() => new Date()))().toISOString().replace(/Z$/, '+00:00')
    let created: TerminalListItem | undefined
    await db.transaction().execute(async tx => {
      if (input.sessionId !== null) {
        const session = (await sql`SELECT id FROM conversation_sessions WHERE id=${input.sessionId} AND user_id=${ownerId}`.execute(tx)).rows[0]
        if (!session) throw new CoreError('not_found', '会话不存在')
      }
      if (input.workspaceId !== null) {
        const workspace = (await sql`SELECT id FROM workspaces WHERE id=${input.workspaceId} AND user_id=${ownerId} AND enabled=true`.execute(tx)).rows[0]
        if (!workspace) throw new CoreError('not_found', '工作区不存在或已停用')
      }
      const row = (await sql<TerminalRecordRow>`
        INSERT INTO terminal_sessions (
          id,owner_id,session_id,workspace_id,run_id,name,source,mode,status,shell_mode,network_profile,
          last_sequence,output_chars,pty_pid,pty_sandbox_id,pty_cols,pty_rows,created_at,updated_at,closed_at
        ) VALUES (
          ${id},${ownerId},${input.sessionId},${input.workspaceId},NULL,${name},'user',${input.mode},'idle','sandbox','none',
          0,0,NULL,NULL,NULL,NULL,${occurredAt},${occurredAt},NULL
        ) RETURNING id,name,session_id,run_id,workspace_id,source,mode,status,shell_mode,network_profile,
          last_sequence,output_chars,pty_pid,pty_sandbox_id,pty_cols,pty_rows,created_at,updated_at,closed_at
      `.execute(tx)).rows[0]
      if (!row) throw new Error('终端创建未返回持久记录')
      created = serializeTerminalRow(row, options.workspaceSupported ?? false)
    })
    if (!created) throw new Error('终端创建事务没有返回结果')
    try { await publishCreated(ownerId, created.id, input.origin) } catch { /* 与 Python 一致，通知失败不回滚已提交终端。 */ }
    return created
  }
}
