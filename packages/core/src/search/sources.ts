import type { GlobalSearchType } from './query.js'
import { searchSnippet } from './global-search.js'

export type SearchRow = Record<string, unknown>

export interface SearchSource {
  type: GlobalSearchType
  label: string
  table: string
  alias: string
  extraSelect?: string
  owner: string
  searchable: readonly string[]
  romajiAlias?: string
  title: string
  subtitle?: string
  extraWhere?: string
  orderBy?: string
  primaryRank?: string
  map(row: SearchRow, queries: readonly string[]): Record<string, unknown>
}

export const SEARCH_SOURCES: readonly SearchSource[] = [
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
      title: row.title || searchSnippet(String(row.content_plain ?? ''), queries) || '无标题便签',
      subtitle: searchSnippet(String(row.content_plain ?? ''), queries), version: row.version,
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
      id: row.id, title: row.title || searchSnippet(String(row.content_plain ?? ''), queries) || '无标题便签',
      subtitle: searchSnippet(String(row.content_plain ?? ''), queries), canvas_id: row.canvas_id,
    }),
  },
]
