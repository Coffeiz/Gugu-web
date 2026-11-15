import type { Pool } from 'pg'
import type { MindReferenceMessage, MindReferenceSuggestionItem } from '@gugu/core/mind'

type Row = Record<string, unknown>

function rowItem(type: string, row: Row, label: unknown, subtitle?: unknown, id: unknown = row.id): MindReferenceSuggestionItem {
  const normalizedId = typeof id === 'string' && type !== 'mcp' && /^\d+$/.test(id) ? Number(id) : id
  return {
    type,
    id: typeof normalizedId === 'number' || typeof normalizedId === 'string' ? normalizedId : Number(normalizedId),
    label: String(label ?? ''),
    subtitle: subtitle === undefined || subtitle === null ? null : String(subtitle),
  }
}

async function recent(pool: Pool, ownerId: string, limit: number): Promise<MindReferenceSuggestionItem[]> {
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
  return [
    ...projects.rows.map(row => rowItem('project', row, row.name, row.client)),
    ...files.rows.map(row => rowItem('file', row, `${row.display_name}.${row.ext}`, row.space)),
    ...folders.rows.map(row => rowItem('folder', row, row.name)),
    ...events.rows.map(row => rowItem('event', row, row.title, row.date)),
    ...canvasNotes.rows.map(row => rowItem('canvas_note', row, row.title || '无标题画布便签', `画布 ${row.canvas_id}`)),
    ...skills.rows.map(row => rowItem('skill', row, row.name, row.skill_id)),
    ...mcpServers.rows.map(row => rowItem('mcp', row, row.name, row.transport, String(row.id))),
    ...tasks.rows.map(row => rowItem('scheduled_task', row, row.name, row.cron)),
  ]
}

export function createPostgresMindReferenceSuggestionPorts(pool: Pool) {
  return {
    recent: (ownerId: string, limit: number) => recent(pool, ownerId, limit),
    async matchingMessages(ownerId: string, query: string, limit: number) {
      const result = await pool.query<Row>(
        `SELECT m.id, m.content, s.title AS session_title FROM conversation_messages m
         JOIN conversation_sessions s ON s.id=m.session_id
         WHERE s.user_id=$1 AND m.content_json IS NULL AND m.role <> 'summary' AND m.content ILIKE $2
         ORDER BY m.created_at DESC LIMIT $3`,
        [ownerId, `%${query}%`, limit],
      )
      return result.rows.map((row): MindReferenceMessage => ({
        id: typeof row.id === 'string' && /^\d+$/.test(row.id) ? Number(row.id) : row.id as number | string,
        content: String(row.content ?? ''),
        sessionTitle: row.session_title === null || row.session_title === undefined ? null : String(row.session_title),
      }))
    },
  }
}
