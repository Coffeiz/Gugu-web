import { sql, type Kysely } from 'kysely'
import { dataContext } from '../contracts/index.js'

/** 读取命令持久事件状态；running 只能证明已提交，不能证明进程仍存活。 */
export function createTerminalCommandStateReader<DB>(db: Kysely<DB>, dialect: 'postgres' | 'sqlite') {
  return async (rawOwner: string, terminal: string, request: string): Promise<'running' | 'finished' | null> => {
    const canonical = dataContext(rawOwner).ownerId
    const owner = dialect === 'sqlite' ? canonical.replaceAll('-', '') : canonical
    const row = (await sql<{ event_type: string; stdout: string | null }>`SELECT e.event_type,e.stdout FROM terminal_events e
      JOIN terminal_sessions t ON t.id=e.terminal_id WHERE t.owner_id=${owner} AND t.id=${terminal} AND e.run_id=${request}
      ORDER BY e.sequence DESC LIMIT 1`.execute(db)).rows[0]
    if (!row) return null
    return row.event_type === 'status' && row.stdout === 'running' ? 'running' : 'finished'
  }
}
