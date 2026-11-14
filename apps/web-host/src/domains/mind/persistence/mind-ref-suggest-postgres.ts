import type { Pool } from 'pg'
import type { GlobalSearchOperations } from '../../search/search.js'
import type { MindRefSuggestItem, MindRefSuggestOperations } from '../mind-ref-suggest.js'
import { MIND_REF_SUGGEST_TYPES } from '../mind-ref-suggest.js'

type Row = Record<string, unknown>

function rowItem(type: string, row: Row, label: unknown, subtitle?: unknown, id: unknown = row.id): MindRefSuggestItem {
  const normalizedId = typeof id === 'string' && type !== 'mcp' && /^\d+$/.test(id) ? Number(id) : id
  return {
    type,
    id: typeof normalizedId === 'number' || typeof normalizedId === 'string' ? normalizedId : Number(normalizedId),
    label: String(label ?? ''),
    ...(subtitle === undefined || subtitle === null ? {} : { subtitle: String(subtitle) }),
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function textSnippet(text: string, query: string): string {
  if (!text) return ''
  const index = text.toLowerCase().indexOf(query.toLowerCase())
  if (index < 0) return text.slice(0, 60).trim()
  const start = Math.max(0, index - 24)
  const end = Math.min(text.length, index + query.length + 24)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim().replace(/\n/g, ' ')}${end < text.length ? '…' : ''}`
}

async function recent(pool: Pool, ownerId: string, limit: number): Promise<MindRefSuggestItem[]> {
  const [projects, files, folders, events, canvasNotes, skills, mcpServers, tasks] = await Promise.all([
    pool.query<Row>('SELECT id, name, contact_name AS client FROM projects WHERE user_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT $2', [ownerId, limit]),
    pool.query<Row>('SELECT id, display_name, ext, space FROM files WHERE user_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT $2', [ownerId, limit]),
    pool.query<Row>('SELECT id, name FROM folders WHERE user_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT $2', [ownerId, limit]),
    pool.query<Row>('SELECT id, title, date FROM calendar_events WHERE user_id=$1 AND deleted_at IS NULL ORDER BY date DESC LIMIT $2', [ownerId, limit]),
    pool.query<Row>(
      `SELECT n.id, n.title, ci.canvas_id FROM mind_nodes n
       JOIN mind_canvas_items ci ON ci.node_id=n.id
       JOIN mind_maps mm ON mm.id=ci.canvas_id
       WHERE n.user_id=$1 AND n.kind='canvas_note' AND n.deleted_at IS NULL
         AND ci.user_id=$1 AND ci.deleted_at IS NULL AND mm.user_id=$1
       ORDER BY n.updated_at DESC, n.id DESC LIMIT $2`,
      [ownerId, limit],
    ),
    pool.query<Row>('SELECT id, name, skill_id FROM user_skills WHERE owner_id=$1 ORDER BY updated_at DESC LIMIT $2', [ownerId, limit]),
    pool.query<Row>(
      `SELECT id, name, transport FROM user_mcp_servers
       WHERE user_id=$1 OR scope='platform' ORDER BY name LIMIT $2`, [ownerId, limit],
    ),
    pool.query<Row>(
      `SELECT id, name, cron FROM scheduled_tasks
       WHERE user_id=$1 AND enabled IS TRUE AND (end_at IS NULL OR end_at > now())
       ORDER BY updated_at DESC LIMIT $2`, [ownerId, limit],
    ),
  ])
  const items = [
    ...projects.rows.map((row) => rowItem('project', row, row.name, row.client)),
    ...files.rows.map((row) => rowItem('file', row, `${row.display_name}.${row.ext}`, row.space)),
    ...folders.rows.map((row) => rowItem('folder', row, row.name)),
    ...events.rows.map((row) => rowItem('event', row, row.title, row.date)),
    ...canvasNotes.rows.map((row) => rowItem('canvas_note', row, row.title || '无标题画布便签', `画布 ${row.canvas_id}`)),
    ...skills.rows.map((row) => rowItem('skill', row, row.name, row.skill_id)),
    ...mcpServers.rows.map((row) => rowItem('mcp', row, row.name, row.transport, String(row.id))),
    ...tasks.rows.map((row) => rowItem('scheduled_task', row, row.name, row.cron)),
  ]
  return items.slice(0, limit * MIND_REF_SUGGEST_TYPES.length)
}

async function matchingMessages(pool: Pool, ownerId: string, query: string, limit: number): Promise<MindRefSuggestItem[]> {
  const result = await pool.query<Row>(
    `SELECT m.id, m.content, s.title AS session_title FROM conversation_messages m
     JOIN conversation_sessions s ON s.id=m.session_id
     WHERE s.user_id=$1 AND m.content_json IS NULL AND m.role <> 'summary' AND m.content ILIKE $2
     ORDER BY m.created_at DESC LIMIT $3`,
    [ownerId, `%${query}%`, limit],
  )
  return result.rows.map((row) => rowItem(
    'conversation', row, textSnippet(String(row.content ?? ''), query), row.session_title,
  ))
}

export function createPostgresMindRefSuggestOperations(
  pool: Pool,
  globalSearch: GlobalSearchOperations,
): MindRefSuggestOperations {
  return {
    async suggest(ownerId, rawQuery, limit) {
      const query = rawQuery.trim()
      if (!query) return recent(pool, ownerId, limit)
      const result = object(await globalSearch.search(ownerId, {
        q: query,
        queries: [query],
        mode: 'OR',
        perType: limit,
        types: MIND_REF_SUGGEST_TYPES,
      }))
      const groups = Array.isArray(result?.groups) ? result.groups : []
      const items: MindRefSuggestItem[] = []
      for (const rawGroup of groups) {
        const group = object(rawGroup)
        if (!group || typeof group.type !== 'string' || !Array.isArray(group.items)) continue
        for (const rawItem of group.items) {
          const item = object(rawItem)
          if (!item || typeof item.title !== 'string' || (typeof item.id !== 'number' && typeof item.id !== 'string')) continue
          items.push(rowItem(group.type, { id: item.id }, item.title, item.subtitle, item.id))
        }
      }
      items.push(...await matchingMessages(pool, ownerId, query, limit))
      return items.slice(0, limit * (MIND_REF_SUGGEST_TYPES.length + 1))
    },
  }
}
