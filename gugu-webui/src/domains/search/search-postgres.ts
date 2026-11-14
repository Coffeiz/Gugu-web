import type { Pool } from 'pg'
import type { GlobalSearchOperations, GlobalSearchQuery, GlobalSearchType } from './search.js'

type Row = Record<string, unknown>

interface SearchSource {
  type: GlobalSearchType
  label: string
  table: string
  alias: string
  extraSelect?: string
  owner: string
  searchable: string[]
  romajiAlias?: string
  title: string
  subtitle?: string
  extraWhere?: string
  orderBy?: string
  primaryRank?: string
  map(row: Row, queries: string[]): Record<string, unknown>
}

function snippet(text: string, queries: string[]): string {
  if (!text) return ''
  const folded = text.toLowerCase()
  const index = queries.map((query) => folded.indexOf(query.toLowerCase())).find((value) => value >= 0) ?? -1
  if (index < 0) return text.slice(0, 60).trim()
  const start = Math.max(0, index - 24)
  const end = Math.min(text.length, index + (queries.find((query) => folded.includes(query.toLowerCase()))?.length ?? 0) + 24)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim().replace(/\n/g, ' ')}${end < text.length ? '…' : ''}`
}

function hitSql(columns: string[]): string {
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

const sources: SearchSource[] = [
  {
    type: 'project', label: '项目', table: 'projects p', alias: 'p', owner: 'p.user_id',
    searchable: ['p.name', 'p.contact_name', 'p.current_stage'], title: 'p.name',
    extraWhere: 'AND p.deleted_at IS NULL', orderBy: 'p.updated_at DESC',
    map: (row) => ({ id: row.id, title: row.name, subtitle: [row.contact_name, row.status].filter(Boolean).join(' · ') }),
  },
  {
    type: 'file', label: '文件', table: 'files f', alias: 'f', owner: 'f.user_id',
    searchable: ['f.display_name', 'f.ext'], romajiAlias: 'f.search_romaji', title: 'f.display_name',
    extraWhere: 'AND f.deleted_at IS NULL', orderBy: 'f.updated_at DESC',
    map: (row) => {
      const label: Record<string, string> = { project: '项目', mind: '思维', asset: '素材', personal: '个人', workspace: '工作区' }
      const space = String(row.space ?? '')
      return {
        id: row.id,
        title: row.ext ? `${row.display_name}.${row.ext}` : row.display_name,
        subtitle: space === 'workspace'
          ? `工作区 · ${row.size ?? ''}`.trim()
          : `${label[space] ?? space}空间 · ${row.size ?? ''}`.trim(),
      }
    },
  },
  {
    type: 'folder', label: '文件夹', table: 'folders f', alias: 'f', owner: 'f.user_id',
    searchable: ['f.name'], romajiAlias: 'f.search_romaji', title: 'f.name', extraWhere: 'AND f.deleted_at IS NULL',
    orderBy: 'f.created_at DESC, f.id DESC',
    map: (row) => ({ id: row.id, title: row.name, subtitle: row.project_id ? '项目' : row.workspace_directory_id ? '工作区' : '个人' }),
  },
  {
    type: 'event', label: '日程', table: 'calendar_events e', alias: 'e', owner: 'e.user_id',
    searchable: ['e.title', 'e.description', 'e.contact_name'], title: 'e.title',
    extraWhere: 'AND e.deleted_at IS NULL', orderBy: 'e.date DESC',
    map: (row) => ({ id: row.id, title: row.title, date: row.date, subtitle: [row.date, row.contact_name].filter(Boolean).join(' · ') }),
  },
  {
    type: 'client', label: '联系人', table: 'clients c', alias: 'c', owner: 'c.user_id',
    searchable: ['c.name', 'c.contact', 'c.email', 'c.phone', 'c.notes'], title: 'c.name',
    orderBy: 'c.created_at DESC',
    map: (row) => ({ id: row.id, title: row.name, subtitle: [row.contact, row.email, row.phone].filter(Boolean).join(' · ') }),
  },
  {
    type: 'skill', label: '技能', table: 'user_skills s', alias: 's', owner: 's.owner_id',
    searchable: ['s.name', 's.skill_id', 's.description_short', 's.description_long'], title: 's.name',
    orderBy: 's.updated_at DESC',
    map: (row) => ({ id: row.skill_id, title: row.name, subtitle: row.description_short, enabled: Boolean(row.enabled) }),
  },
  {
    type: 'mcp', label: 'MCP', table: 'user_mcp_servers m', alias: 'm', owner: 'TRUE',
    searchable: ['m.name'], title: 'm.name', extraWhere: "AND (m.user_id = $1 OR m.scope = 'platform')",
    orderBy: 'm.name ASC',
    map: (row) => ({ id: String(row.id), title: row.name, subtitle: `${row.transport} · ${row.enabled ? '已启用' : '已停用'}`, enabled: Boolean(row.enabled) }),
  },
  {
    type: 'scheduled_task', label: '定时任务', table: 'scheduled_tasks t', alias: 't', owner: 't.user_id',
    searchable: ['t.name'], title: 't.name',
    extraWhere: 'AND t.enabled IS TRUE AND (t.end_at IS NULL OR t.end_at > now())', orderBy: 't.updated_at DESC',
    map: (row) => ({
      id: row.id, title: row.name,
      subtitle: row.schedule_kind === 'cron' ? `${row.schedule_kind} · ${row.cron}` : row.interval_minutes ? `每 ${row.interval_minutes} 分钟` : '定时',
    }),
  },
  {
    type: 'note', label: '便签', table: 'mind_nodes n', alias: 'n', owner: 'n.user_id',
    searchable: ['n.title', 'n.content_plain'], title: 'COALESCE(n.title, \'\')',
    extraWhere: "AND n.kind = 'note' AND n.deleted_at IS NULL",
    primaryRank: "CASE WHEN lower(COALESCE(n.title,''))=lower($3) THEN 0 WHEN lower(COALESCE(n.title,'')) LIKE lower($3)||'%' THEN 1 WHEN n.title ILIKE ('%'||$3||'%') THEN 2 ELSE 3 END",
    orderBy: `n.captured_at DESC`,
    map: (row, queries) => ({
      id: row.id,
      title: row.title || snippet(String(row.content_plain ?? ''), queries) || '无标题便签',
      subtitle: snippet(String(row.content_plain ?? ''), queries), version: row.version,
    }),
  },
  {
    type: 'canvas_note', label: '画布便签',
    table: 'mind_nodes n JOIN mind_canvas_items ci ON ci.node_id=n.id JOIN mind_maps mm ON mm.id=ci.canvas_id',
    alias: 'n', extraSelect: ', ci.canvas_id', owner: 'n.user_id',
    searchable: ['n.title', 'n.content_plain'], title: 'COALESCE(n.title, \'\')',
    extraWhere: "AND n.kind = 'canvas_note' AND n.deleted_at IS NULL AND ci.user_id=$1 AND ci.deleted_at IS NULL AND mm.user_id=$1 AND mm.deleted_at IS NULL",
    primaryRank: "CASE WHEN lower(COALESCE(n.title,''))=lower($3) THEN 0 WHEN lower(COALESCE(n.title,'')) LIKE lower($3)||'%' THEN 1 WHEN n.title ILIKE ('%'||$3||'%') THEN 2 ELSE 3 END",
    orderBy: 'n.updated_at DESC, n.id DESC',
    map: (row, queries) => ({
      id: row.id, title: row.title || snippet(String(row.content_plain ?? ''), queries) || '无标题便签',
      subtitle: snippet(String(row.content_plain ?? ''), queries), canvas_id: row.canvas_id,
    }),
  },
]

async function searchSource(
  pool: Pool,
  ownerId: string,
  query: GlobalSearchQuery,
  source: SearchSource,
): Promise<Array<Record<string, unknown>>> {
  const usesRomaji = query.queries.some((term) => /^[A-Za-z ]+$/.test(term) && /[A-Za-z]/.test(term))
  const searchable = usesRomaji && source.romajiAlias
    ? [...source.searchable, source.romajiAlias]
    : source.searchable
  const result = await pool.query<Row>(sourceSql({ ...source, searchable }, query.mode), [ownerId, query.queries, query.queries[0], query.perType])
  const mapped = result.rows.map((row) => source.map(row, query.queries))
  if (source.type !== 'file' && source.type !== 'folder') return mapped
  return Promise.all(result.rows.map(async (row, index) => {
    const item = mapped[index]!
    const isFolder = source.type === 'folder'
    const workspaceId = row.workspace_directory_id
    const projectId = row.project_id
    const targetFolderId = isFolder ? row.id : row.folder_id
    const chain = targetFolderId === null || targetFolderId === undefined
      ? []
      : await readOwnedFolderChain(pool, ownerId, Number(targetFolderId))
    const folderPath = isFolder ? chain.slice(0, -1) : chain

    if (workspaceId !== null && workspaceId !== undefined) {
      const directory = await pool.query<Row>(
        'SELECT id, name FROM workspace_directories WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',
        [workspaceId, ownerId],
      )
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
        const project = await pool.query<Row>(
          'SELECT name FROM projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',
          [projectId, ownerId],
        )
        item.subtitle = `项目 · ${project.rows[0]?.name ?? '项目'} · ${path}`
      } else item.subtitle = `个人 · ${path}`
    }
    return item
  }))
}

async function readOwnedFolderChain(pool: Pool, ownerId: string, folderId: number): Promise<Row[]> {
  const result = await pool.query<{ path: Row[] | null; root_parent_id: number | null }>(`
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
    FROM folder_chain`, [folderId, ownerId])
  const row = result.rows[0]
  if (!row?.path || row.root_parent_id !== null) return []
  return row.path
}

async function searchConversations(pool: Pool, ownerId: string, query: GlobalSearchQuery) {
  const sessionHits = hitSql(['s.title'])
  const messageHits = hitSql(['m.content'])
  const modeCondition = (hits: string) => query.mode === 'AND'
    ? `${hits} = cardinality($2::text[])`
    : `${hits} > 0`
  const titles = await pool.query<Row>(`
    SELECT s.id, s.title, '对话' AS subtitle, NULL::bigint AS message_id, ${sessionHits} AS search_hits
    FROM conversation_sessions s WHERE s.user_id=$1 AND ${modeCondition(sessionHits)}
    ORDER BY search_hits DESC, CASE WHEN lower(s.title)=lower($3) THEN 0 WHEN lower(s.title) LIKE lower($3)||'%' THEN 1 ELSE 2 END,
      s.updated_at DESC LIMIT $4`, [ownerId, query.queries, query.queries[0], query.perType])
  const messages = await pool.query<Row>(`
    SELECT s.id, s.title, m.id AS message_id, m.content, ${messageHits} AS search_hits
    FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id
    WHERE s.user_id=$1 AND ${modeCondition(messageHits)}
    ORDER BY search_hits DESC, m.created_at DESC LIMIT $4`, [ownerId, query.queries, query.queries[0], 8])
  const items = new Map<string, Record<string, unknown>>()
  for (const row of titles.rows) items.set(String(row.id), { id: row.id, title: row.title, subtitle: row.subtitle })
  for (const row of messages.rows) {
    if (!items.has(String(row.id))) items.set(String(row.id), {
      id: row.id, title: row.title, subtitle: snippet(String(row.content ?? ''), query.queries), message_id: row.message_id,
    })
    if (items.size >= query.perType) break
  }
  return [...items.values()].slice(0, query.perType)
}

export function createPostgresGlobalSearchOperations(pool: Pool): GlobalSearchOperations {
  return {
    async search(ownerId, query) {
      if (query.queries.length === 0) return { query: query.q.trim(), queries: [], mode: query.mode, total: 0, groups: [] }
      const wanted = query.types ? new Set(query.types) : null
      const groups: Array<{ type: GlobalSearchType; label: string; items: Array<Record<string, unknown>> }> = []
      for (const source of sources) {
        if (wanted && !wanted.has(source.type)) continue
        const items = await searchSource(pool, ownerId, query, source)
        if (items.length) groups.push({ type: source.type, label: source.label, items })
      }
      if (!wanted || wanted.has('conversation')) {
        const items = await searchConversations(pool, ownerId, query)
        if (items.length) groups.push({ type: 'conversation', label: '对话', items })
      }
      const order = ['project', 'file', 'folder', 'event', 'client', 'skill', 'mcp', 'scheduled_task', 'note', 'canvas_note', 'conversation']
      groups.sort((left, right) => order.indexOf(left.type) - order.indexOf(right.type))
      return {
        query: query.q.trim() || query.queries.join(' '), queries: query.queries, mode: query.mode,
        total: groups.reduce((sum, group) => sum + group.items.length, 0), groups,
      }
    },
  }
}
