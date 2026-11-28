import { sql, type Kysely } from 'kysely'
import { CoreError, dataContext } from '../contracts/index.js'
import { serializeTerminalRow, type TerminalListItem, type TerminalRecordRow } from './list.js'

function ownerFor(rawOwner: string, dialect: 'postgres' | 'sqlite'): string {
  try {
    const owner = dataContext(rawOwner).ownerId
    return dialect === 'sqlite' ? owner.replaceAll('-', '') : owner
  } catch { throw new CoreError('invalid_request', '用户 ID 无效') }
}

async function ensureOwnedSession<DB>(tx: Kysely<DB>, owner: string, row: { session_id: number | null }): Promise<void> {
  if (row.session_id === null) return
  const session = (await sql`SELECT id FROM conversation_sessions WHERE id=${row.session_id} AND user_id=${owner}`.execute(tx)).rows[0]
  if (!session) throw Object.assign(new Error('终端会话不存在'), { statusCode: 403 })
}

async function ownedRow<DB>(tx: Kysely<DB>, owner: string, terminalId: string): Promise<TerminalRecordRow> {
  const row = (await sql<TerminalRecordRow>`
    SELECT id,name,session_id,run_id,workspace_id,source,mode,status,shell_mode,network_profile,
      last_sequence,output_chars,pty_pid,pty_sandbox_id,pty_cols,pty_rows,created_at,updated_at,closed_at
    FROM terminal_sessions WHERE owner_id=${owner} AND id=${terminalId}
  `.execute(tx)).rows[0]
  if (!row) throw new CoreError('not_found', '终端不存在')
  await ensureOwnedSession(tx, owner, row)
  return row
}

/** Read only the owner-scoped runtime identity Host needs before a physical stop. */
export async function readTerminalCleanupState<DB>(
  db: Kysely<DB>, dialect: 'postgres' | 'sqlite', rawOwner: string, terminalId: string,
) {
  const owner = ownerFor(rawOwner, dialect)
  const row = await ownedRow(db, owner, terminalId)
  return {
    id: row.id,
    mode: row.mode ?? 'agent-events',
    status: row.status,
    closedAt: row.closed_at === null ? null : row.closed_at instanceof Date ? row.closed_at.toISOString() : row.closed_at,
    ptySandboxId: row.pty_sandbox_id,
  }
}

/** Reset only runtime state, retaining terminal bindings, history and output counters. */
export async function resetTerminalForOwner<DB>(
  db: Kysely<DB>, dialect: 'postgres' | 'sqlite', rawOwner: string, terminalId: string,
  now: () => Date = () => new Date(),
): Promise<TerminalListItem> {
  const owner = ownerFor(rawOwner, dialect)
  return db.transaction().execute(async tx => {
    await ownedRow(tx, owner, terminalId)
    const timestamp = now().toISOString().replace(/Z$/, '+00:00')
    const row = (await sql<TerminalRecordRow>`
      UPDATE terminal_sessions SET status='idle',closed_at=NULL,pty_pid=NULL,pty_sandbox_id=NULL,
        pty_cols=NULL,pty_rows=NULL,updated_at=${timestamp}
      WHERE owner_id=${owner} AND id=${terminalId}
      RETURNING id,name,session_id,run_id,workspace_id,source,mode,status,shell_mode,network_profile,
        last_sequence,output_chars,pty_pid,pty_sandbox_id,pty_cols,pty_rows,created_at,updated_at,closed_at
    `.execute(tx)).rows[0]
    if (!row) throw new CoreError('not_found', '终端不存在')
    return serializeTerminalRow(row, true)
  })
}

/** Stop a terminal view and append its ordered status event in the same transaction. */
export async function terminateTerminalForOwner<DB>(
  db: Kysely<DB>, dialect: 'postgres' | 'sqlite', rawOwner: string, terminalId: string,
  now: () => Date = () => new Date(),
): Promise<TerminalListItem> {
  const owner = ownerFor(rawOwner, dialect)
  return db.transaction().execute(async tx => {
    const current = await ownedRow(tx, owner, terminalId)
    const timestamp = now().toISOString().replace(/Z$/, '+00:00')
    const row = (await sql<TerminalRecordRow>`
      UPDATE terminal_sessions SET status='terminated',closed_at=${timestamp},updated_at=${timestamp},last_sequence=last_sequence+1
      WHERE owner_id=${owner} AND id=${terminalId}
      RETURNING id,name,session_id,run_id,workspace_id,source,mode,status,shell_mode,network_profile,
        last_sequence,output_chars,pty_pid,pty_sandbox_id,pty_cols,pty_rows,created_at,updated_at,closed_at
    `.execute(tx)).rows[0]
    if (!row) throw new CoreError('not_found', '终端不存在')
    await sql`INSERT INTO terminal_events(terminal_id,run_id,sequence,event_type,source,command,stdout,stderr,exit_code,occurred_at)
      VALUES(${terminalId},${current.run_id},${row.last_sequence},'status','user',NULL,'','',NULL,${timestamp})`.execute(tx)
    return serializeTerminalRow(row, true)
  })
}
