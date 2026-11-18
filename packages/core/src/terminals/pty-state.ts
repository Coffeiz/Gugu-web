import { sql, type Kysely } from 'kysely'
import { CoreError, dataContext } from '../contracts/index.js'

export interface TerminalPtyIdentity {
  workspaceId: number | null
  pid: number
  sandboxId: string
  cols: number
  rows: number
}

function ownerFor(rawOwner: string, dialect: 'postgres' | 'sqlite'): string {
  try {
    const owner = dataContext(rawOwner).ownerId
    return dialect === 'sqlite' ? owner.replaceAll('-', '') : owner
  } catch { throw new CoreError('invalid_request', '用户 ID 无效') }
}

/** Persist a PTY only after its owner, linked session and workspace are revalidated. */
export async function markTerminalPtyRunning<DB>(
  db: Kysely<DB>, dialect: 'postgres' | 'sqlite', rawOwner: string, terminalId: string,
  pty: TerminalPtyIdentity, now: () => Date = () => new Date(),
) {
  const owner = ownerFor(rawOwner, dialect)
  if (!Number.isSafeInteger(pty.pid) || pty.pid < 1 || !pty.sandboxId
    || !Number.isInteger(pty.cols) || pty.cols < 20 || pty.cols > 500
    || !Number.isInteger(pty.rows) || pty.rows < 5 || pty.rows > 200)
    throw new CoreError('invalid_request', 'PTY 状态无效')
  return db.transaction().execute(async tx => {
    const row = (await sql<{ id: string; session_id: number | null; workspace_id: number | null; mode: string; status: string; closed_at: string | null }>`
      SELECT id,session_id,workspace_id,mode,status,closed_at FROM terminal_sessions
      WHERE owner_id=${owner} AND id=${terminalId}
    `.execute(tx)).rows[0]
    if (!row || row.mode !== 'interactive-pty') throw new CoreError('not_found', '交互式终端不存在')
    if (row.closed_at !== null || row.status === 'terminated') throw Object.assign(new Error('终端已终止，请先重新打开'), { statusCode: 403 })
    if (row.workspace_id !== pty.workspaceId) throw Object.assign(new Error('终端工作区绑定已变化，请刷新后重试'), { statusCode: 403 })
    if (row.session_id !== null) {
      const session = (await sql`SELECT id FROM conversation_sessions WHERE id=${row.session_id} AND user_id=${owner}`.execute(tx)).rows[0]
      if (!session) throw Object.assign(new Error('终端会话不存在'), { statusCode: 403 })
    }
    if (row.workspace_id !== null) {
      const workspace = (await sql`SELECT id FROM workspaces WHERE id=${row.workspace_id} AND user_id=${owner}`.execute(tx)).rows[0]
      if (!workspace) throw Object.assign(new Error('终端绑定的 Workspace 已删除'), { statusCode: 403 })
    }
    const timestamp = now().toISOString().replace(/Z$/, '+00:00')
    const updated = await sql`UPDATE terminal_sessions SET status='running',pty_pid=${pty.pid},pty_sandbox_id=${pty.sandboxId},
      pty_cols=${pty.cols},pty_rows=${pty.rows},updated_at=${timestamp}
      WHERE owner_id=${owner} AND id=${terminalId} AND mode='interactive-pty' AND closed_at IS NULL AND status<>'terminated'
        AND workspace_id IS NOT DISTINCT FROM ${pty.workspaceId}
      RETURNING id`.execute(tx)
    if (!updated.rows[0]) throw Object.assign(new Error('终端状态已变化，请重试'), { statusCode: 403 })
    return {
      status: 'running' as const, workspaceId: pty.workspaceId, ptyPid: pty.pid,
      ptySandboxId: pty.sandboxId, ptyCols: pty.cols, ptyRows: pty.rows,
      closedAt: null, updatedAt: timestamp,
    }
  })
}

/** Mark natural exit atomically without overwriting an explicit termination. */
export async function markTerminalPtyExited<DB>(
  db: Kysely<DB>, dialect: 'postgres' | 'sqlite', rawOwner: string, terminalId: string,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const owner = ownerFor(rawOwner, dialect)
  const timestamp = now().toISOString().replace(/Z$/, '+00:00')
  const updated = await sql`UPDATE terminal_sessions SET status='exited',closed_at=${timestamp},updated_at=${timestamp}
    WHERE owner_id=${owner} AND id=${terminalId} AND mode='interactive-pty' AND status<>'terminated' AND closed_at IS NULL
    RETURNING id`.execute(db)
  return Boolean(updated.rows[0])
}
