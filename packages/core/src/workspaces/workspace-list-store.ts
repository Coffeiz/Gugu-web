import { sql, type Kysely } from 'kysely'
import { dataContext } from '../contracts/index.js'
import type { WorkspaceListReadPort, WorkspaceListRow } from './workspace-list.js'

/** 既有管理查询所需的最小表契约，不创建表或替代正式schema迁移。 */
export interface WorkspaceListTables {
  user_preferences: { user_id: string; data_json: string | null }
  workspaces: Omit<WorkspaceListRow, 'enabled' | 'is_default'> & {
    user_id: string
    enabled: boolean | number
    is_default: boolean | number
    updated_at: string | Date
  }
  conversation_sessions: { id: number; user_id: string; workspace_id: number | null }
}

/** 连接由Host持有；缺表/数据库失败直接传播，不返回伪造的空列表。 */
export function createKyselyWorkspaceListReader(db: Kysely<WorkspaceListTables>, backend: 'sqlite' | 'postgres'): WorkspaceListReadPort {
  async function read<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted()
    // 等待驱动归还连接后才传播取消，不用race提前结束仍在运行的查询。
    try { return await work() } finally { signal?.throwIfAborted() }
  }
  function owner(rawOwner: string): string {
    const id = dataContext(rawOwner).ownerId
    return backend === 'sqlite' ? id.replaceAll('-', '') : id
  }
  return {
    async preferences(ownerId, signal) {
      return read(signal, async () => {
        const row = await db.selectFrom('user_preferences').select('data_json').where('user_id', '=', owner(ownerId)).executeTakeFirst()
        return row?.data_json
      })
    },
    async workspaces(ownerId, signal) {
      return read(signal, async () => {
        const rows = await db.selectFrom('workspaces')
        .select(['id', 'name', 'kind', 'folder_id', 'project_id', 'directory_id', 'enabled', 'is_default'])
        .where('user_id', '=', owner(ownerId)).orderBy('updated_at', 'desc').execute()
        return rows.map(row => ({ ...row, enabled: Boolean(row.enabled), is_default: Boolean(row.is_default) }))
      })
    },
    async boundSessionCounts(ownerId, signal) {
      return read(signal, () => db.selectFrom('conversation_sessions')
        .select(['workspace_id', db.fn.count<number | string>('id').as('count')])
        .where('user_id', '=', owner(ownerId)).where('workspace_id', 'is not', null)
        .groupBy('workspace_id').execute() as Promise<Array<{ workspace_id: number; count: number | string }>>)
    },
  }
}

/** 与管理列表同属工作区域；关联名称及计数均在SQL内按同一owner验证。 */
export function createKyselyAgentWorkspaceReader(db: Kysely<any>, backend: 'sqlite' | 'postgres'): import('./workspace-list.js').WorkspaceAgentReadPort {
  return { async read(rawOwner, workspaceId, signal) {
    signal?.throwIfAborted()
    const normalized = dataContext(rawOwner).ownerId, owner = backend === 'sqlite' ? normalized.replaceAll('-', '') : normalized
    const filter = workspaceId === undefined ? sql`` : sql` AND w.id=${workspaceId}`
    try {
      const result = await sql<Record<string, unknown>>`SELECT w.id,w.name,w.kind,w.enabled,w.is_default,w.project_id,w.folder_id,w.directory_id,
        p.name AS project_name,f.name AS folder_name,d.name AS directory_name,
        (SELECT count(*) FROM conversation_sessions s WHERE s.user_id=${owner} AND s.workspace_id=w.id) AS bound_session_count
        FROM workspaces w LEFT JOIN projects p ON p.id=w.project_id AND p.user_id=w.user_id
        LEFT JOIN folders f ON f.id=w.folder_id AND f.user_id=w.user_id
        LEFT JOIN workspace_directories d ON d.id=w.directory_id AND d.user_id=w.user_id
        WHERE w.user_id=${owner}${filter} ORDER BY w.updated_at DESC,w.id DESC`.execute(db)
      return result.rows.map(row => ({ workspace_id: Number(row.id), name: String(row.name), kind: String(row.kind), enabled: Boolean(row.enabled),
        is_default: Boolean(row.is_default), bound_session_count: Number(row.bound_session_count), project_id: row.project_id == null ? null : Number(row.project_id),
        folder_id: row.folder_id == null ? null : Number(row.folder_id),
        ...(row.project_id == null ? {} : { project_name: row.project_name == null ? null : String(row.project_name) }),
        ...(row.folder_id == null ? {} : { folder_name: row.folder_name == null ? null : String(row.folder_name) }),
        ...(row.directory_id == null ? {} : { directory_id: Number(row.directory_id), directory_name: row.directory_name == null ? null : String(row.directory_name) }) }))
    } finally { signal?.throwIfAborted() }
  } }
}
