import { CANVAS_NOTE_TITLE_LIMIT, canvasNoteDisplayTitle } from '../mind/note-create.js'
import { searchSnippet, type GlobalSearchType } from '@gugu/search'

export type SearchRow = Record<string, unknown>

function noteSearchSubtitle(content: string, title: string, queries: readonly string[], titleLimit?: number): string {
  const text = content.trim()
  const firstLine = text.split(/\r?\n/u, 1)[0] ?? ''
  const displayedFirstLine = titleLimit ? [...firstLine].slice(0, titleLimit).join('') : firstLine
  const body = displayedFirstLine === title ? text.slice(firstLine.length).trimStart() : text
  const subtitle = searchSnippet(body, queries)
  return subtitle === title ? '' : subtitle
}

export interface SearchSource {
  type: GlobalSearchType
  label: string
  table: string
  alias: string
  extraSelect?: string
  owner: string
  searchable: readonly string[]
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
    type: 'event', label: '日程', table: 'calendar_events e', alias: 'e', owner: 'e.user_id',
    searchable: ['e.title', 'e.description', 'e.contact_name'], title: 'e.title',
    extraWhere: 'AND e.deleted_at IS NULL', orderBy: 'e.date DESC',
    map: (row) => ({ id: row.id, title: row.title, date: row.date, subtitle: [row.date, row.contact_name].filter(Boolean).join(' · ') }),
  },
  {
    type: 'client', label: '联系人', table: 'clients c', alias: 'c', owner: 'c.user_id',
    searchable: ['c.name', 'c.email', 'c.phone', 'c.address', 'c.notes'], title: 'c.name',
    orderBy: 'c.created_at DESC',
    map: (row) => ({ id: row.id, title: row.name, subtitle: [row.email, row.phone].filter(Boolean).join(' · ') }),
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
    map: (row, queries) => {
      const content = String(row.content_plain ?? '')
      const title = String(row.title || searchSnippet(content, queries) || '无标题便签')
      return { id: row.id, title, subtitle: noteSearchSubtitle(content, title, queries), version: row.version }
    },
  },
  {
    type: 'canvas_note', label: '画布便签',
    table: 'mind_nodes n JOIN mind_canvas_items ci ON ci.node_id=n.id JOIN mind_maps mm ON mm.id=ci.canvas_id',
    alias: 'n', extraSelect: ', ci.canvas_id', owner: 'n.user_id',
    searchable: ['n.title', 'n.content_plain'], title: 'COALESCE(n.title, \'\')',
    extraWhere: "AND n.kind = 'canvas_note' AND n.deleted_at IS NULL AND ci.user_id=$1 AND ci.deleted_at IS NULL AND mm.user_id=$1 AND mm.deleted_at IS NULL",
    primaryRank: "CASE WHEN lower(COALESCE(n.title,''))=lower($3) THEN 0 WHEN lower(COALESCE(n.title,'')) LIKE lower($3)||'%' THEN 1 WHEN n.title ILIKE ('%'||$3||'%') THEN 2 ELSE 3 END",
    orderBy: 'n.updated_at DESC, n.id DESC',
    map: (row, queries) => {
      const title = canvasNoteDisplayTitle(row)
      return { id: row.id, title, subtitle: noteSearchSubtitle(String(row.content_plain ?? ''), title, queries, CANVAS_NOTE_TITLE_LIMIT),
        canvas_id: row.canvas_id }
    },
  },
]
