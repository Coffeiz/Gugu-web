import type { Pool } from 'pg'
import type { GlobalSearchQuery } from './query.js'
import type { GlobalSearchSource } from './global-search.js'
import { searchSnippet } from './global-search.js'
import { SEARCH_SOURCES } from './sources.js'
import type { SearchRow, SearchSource } from './sources.js'

type QueryPool = Pick<Pool, 'query'>

function hitSql(columns: readonly string[]): string {
  const candidate = columns.map((column) => `COALESCE(${column}, '') ILIKE ('%' || term.value || '%')`).join(' OR ')
  return `(SELECT count(*) FROM unnest($2::text[]) AS term(value) WHERE (${candidate}))`
}

function sourceSql(source: SearchSource, mode: GlobalSearchQuery['mode']): string {
  const hits = hitSql(source.searchable)
  const match = mode === 'AND' ? `${hits} = cardinality($2::text[])` : `${hits} > 0`
  const primary = source.primaryRank
    ?? `CASE WHEN lower(${source.title}) = lower($3) THEN 0 WHEN lower(${source.title}) LIKE lower($3) || '%' THEN 1 ELSE 2 END`
  const ownerCheck = source.owner === 'TRUE' ? 'TRUE' : `${source.owner} = $1`
  return `SELECT ${source.alias}.*${source.extraSelect ?? ''}, ${hits} AS search_hits FROM ${source.table}
    WHERE ${ownerCheck} ${source.extraWhere ?? ''} AND ${match}
    ORDER BY search_hits DESC, ${primary}, ${source.orderBy ?? 'updated_at DESC'} LIMIT $4`
}

async function searchSource(
  pool: QueryPool,
  ownerId: string,
  query: GlobalSearchQuery,
  source: SearchSource,
  signal?: AbortSignal,
): Promise<Array<Record<string, unknown>>> {
  signal?.throwIfAborted()
  const usesRomaji = query.queries.some((term) => /^[A-Za-z ]+$/.test(term) && /[A-Za-z]/.test(term))
  const searchable = usesRomaji && source.romajiAlias
    ? [...source.searchable, source.romajiAlias]
    : source.searchable
  const result = await pool.query<SearchRow>(sourceSql({ ...source, searchable }, query.mode), [ownerId, query.queries, query.queries[0], query.perType]).finally(() => signal?.throwIfAborted())
  const mapped = result.rows.map((row) => source.map(row, query.queries))
  if (source.type !== 'file' && source.type !== 'folder') return mapped
  // 等待所有已启动位置查询清理后再传播取消或错误，不能Promise.all提前丢下兄弟查询。
  const outcomes = await Promise.allSettled(result.rows.map(async (row, index) => {
    signal?.throwIfAborted()
    const item = mapped[index]!
    const isFolder = source.type === 'folder'
    const workspaceId = row.workspace_directory_id
    const projectId = row.project_id
    const targetFolderId = isFolder ? row.id : row.folder_id
    const chain = targetFolderId === null || targetFolderId === undefined
      ? []
      : await readOwnedFolderChain(pool, ownerId, Number(targetFolderId), signal)
    const folderPath = isFolder ? chain.slice(0, -1) : chain

    if (workspaceId !== null && workspaceId !== undefined) {
      const directory = await pool.query<SearchRow>(
        'SELECT id, name FROM workspace_directories WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',
        [workspaceId, ownerId],
      ).finally(() => signal?.throwIfAborted())
      const workspace = directory.rows[0]
      if (workspace) {
        item.workspace_directory_id = workspace.id
        item.workspace_directory_name = workspace.name
        item.folder_path = folderPath
        const location = (isFolder ? chain : folderPath).map((folder) => String(folder.name)).join('/')
        item.subtitle = isFolder
          ? ['工作区', workspace.name, location].filter(Boolean).join(' · ')
          : ['工作区', workspace.name, location, row.size].filter(Boolean).join(' · ')
      }
    } else if (isFolder) {
      const path = chain.map((folder) => String(folder.name)).join('/') || String(row.name)
      if (projectId !== null && projectId !== undefined) {
        const project = await pool.query<SearchRow>(
          'SELECT name FROM projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',
          [projectId, ownerId],
        ).finally(() => signal?.throwIfAborted())
        item.subtitle = `项目 · ${project.rows[0]?.name ?? '项目'} · ${path}`
      } else item.subtitle = `个人 · ${path}`
    }
    return item
  }))
  signal?.throwIfAborted()
  const failed = outcomes.find(outcome => outcome.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
  return outcomes.map(outcome => {
    if (outcome.status !== 'fulfilled') throw new Error('搜索位置查询结果无效')
    return outcome.value
  })
}

async function readOwnedFolderChain(pool: QueryPool, ownerId: string, folderId: number, signal?: AbortSignal): Promise<SearchRow[]> {
  signal?.throwIfAborted()
  const result = await pool.query<{ path: SearchRow[] | null; root_parent_id: number | null }>(`
    WITH RECURSIVE folder_chain AS (
      SELECT id, user_id, project_id, workspace_directory_id, parent_id, name, 0 AS depth
      FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
      UNION ALL
      SELECT parent.id, parent.user_id, parent.project_id, parent.workspace_directory_id,
        parent.parent_id, parent.name, child.depth+1
      FROM folders parent JOIN folder_chain child ON child.parent_id=parent.id
      WHERE parent.user_id=$2 AND parent.deleted_at IS NULL
        AND parent.project_id IS NOT DISTINCT FROM child.project_id
        AND parent.workspace_directory_id IS NOT DISTINCT FROM child.workspace_directory_id
        AND child.depth < 63
    )
    SELECT json_agg(json_build_object('id', id, 'name', name) ORDER BY depth DESC) AS path,
      (array_agg(parent_id ORDER BY depth DESC))[1] AS root_parent_id
    FROM folder_chain`, [folderId, ownerId]).finally(() => signal?.throwIfAborted())
  const row = result.rows[0]
  if (!row?.path || row.root_parent_id !== null) return []
  return row.path
}

async function searchConversations(pool: QueryPool, ownerId: string, query: GlobalSearchQuery, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const sessionHits = hitSql(['s.title'])
  const messageHits = hitSql(['m.content'])
  const modeCondition = (hits: string) => query.mode === 'AND'
    ? `${hits} = cardinality($2::text[])`
    : `${hits} > 0`
  const titles = await pool.query<SearchRow>(`
    SELECT s.id, s.title, '对话' AS subtitle, NULL::bigint AS message_id, ${sessionHits} AS search_hits
    FROM conversation_sessions s WHERE s.user_id=$1 AND ${modeCondition(sessionHits)}
    ORDER BY search_hits DESC, CASE WHEN lower(s.title)=lower($3) THEN 0 WHEN lower(s.title) LIKE lower($3)||'%' THEN 1 ELSE 2 END,
      s.updated_at DESC LIMIT $4`, [ownerId, query.queries, query.queries[0], query.perType]).finally(() => signal?.throwIfAborted())
  const messages = await pool.query<SearchRow>(`
    SELECT s.id, s.title, m.id AS message_id, m.content, ${messageHits} AS search_hits
    FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id
    WHERE s.user_id=$1 AND ${modeCondition(messageHits)}
    ORDER BY search_hits DESC, m.created_at DESC LIMIT $3`, [ownerId, query.queries, 8]).finally(() => signal?.throwIfAborted())
  const items = new Map<string, Record<string, unknown>>()
  for (const row of titles.rows) items.set(String(row.id), { id: row.id, title: row.title, subtitle: row.subtitle })
  for (const row of messages.rows) {
    if (!items.has(String(row.id))) items.set(String(row.id), {
      id: row.id, title: row.title, subtitle: searchSnippet(String(row.content ?? ''), query.queries), message_id: row.message_id,
    })
    if (items.size >= query.perType) break
  }
  return [...items.values()].slice(0, query.perType)
}

/** 复用Host既有PG搜索业务；调用方持有连接池，来源不取得或关闭其生命周期。 */
export function createPostgresGlobalSearchSources(pool: QueryPool): GlobalSearchSource[] {
  return [
    ...SEARCH_SOURCES.map(source => ({
      type: source.type,
      label: source.label,
      async search(ownerId: string, query: GlobalSearchQuery, signal?: AbortSignal) {
        signal?.throwIfAborted()
        return searchSource(pool, ownerId, query, source, signal).finally(() => signal?.throwIfAborted())
      },
    })),
    {
      type: 'conversation', label: '对话',
      async search(ownerId, query, signal) {
        signal?.throwIfAborted()
        return searchConversations(pool, ownerId, query, signal).finally(() => signal?.throwIfAborted())
      },
    },
  ]
}
