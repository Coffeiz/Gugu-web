import type { Pool } from 'pg'
import type { ContextDataPorts, HistoryIdentity, Json } from '@gugu/core/agent'
import { agentContextSubject } from './agent-context-subject.js'
import { dateKeyInTimeZone } from '../../../shared/date-time.js'

type QueryPool = Pick<Pool, 'query'>
interface AgentProjectOverview { total_file_count: number; root_file_count: number; total_folder_count: number; roots: string[] }

/** 快照批量统计并附加根目录，避免逐项目查询；单项目工具复用项目领域的 readProjectFileOverview。 */
async function loadAgentProjectOverviews(pool: QueryPool, ownerId: string, ids: readonly number[]): Promise<Map<number, AgentProjectOverview>> {
  const result = new Map<number, AgentProjectOverview>()
  if (!ids.length) return result
  const folders = (await pool.query(`SELECT f.project_id,f.parent_id,f.name FROM folders f JOIN projects p ON p.id=f.project_id AND p.user_id=f.user_id WHERE f.user_id=$1 AND f.project_id=ANY($2::int[]) AND f.deleted_at IS NULL ORDER BY f.id`, [ownerId, ids])).rows
  const counts = (await pool.query(`SELECT f.project_id,count(*)::int AS total,count(*) FILTER (WHERE f.folder_id IS NULL)::int AS root FROM files f JOIN projects p ON p.id=f.project_id AND p.user_id=f.user_id WHERE f.user_id=$1 AND f.space='project' AND f.project_id=ANY($2::int[]) AND f.deleted_at IS NULL GROUP BY f.project_id`, [ownerId, ids])).rows
  for (const id of ids) {
    const ownedFolders = folders.filter(folder => folder.project_id === id), count = counts.find(item => item.project_id === id)
    result.set(id, { total_file_count: count?.total ?? 0, root_file_count: count?.root ?? 0, total_folder_count: ownedFolders.length, roots: ownedFolders.filter(folder => folder.parent_id == null).map(folder => folder.name) })
  }
  return result
}
async function owned(pool: QueryPool, identity: HistoryIdentity, kind: 'chat' | 'scheduled_task', signal?: AbortSignal) {
  signal?.throwIfAborted()
  const subject = agentContextSubject(kind, identity)
  const result = await pool.query(`SELECT 1 FROM ${subject.from} AS s WHERE s.id=$1 AND s.user_id=$2`, [subject.id, identity.ownerId])
  if (result.rowCount !== 1) throw new Error(subject.missing)
  signal?.throwIfAborted()
}

/** 数据读取严格限定 owner；只返回模型快照所需的受限概览。 */
export function createAgentOverviewSources(pool: QueryPool, now: () => Date = () => new Date(), kind: 'chat' | 'scheduled_task' = 'chat'): Pick<ContextDataPorts, 'loadProjects' | 'loadEvents' | 'loadNotes' | 'loadFilesOverview'> {
  return {
    async loadProjects(identity, signal) {
      await owned(pool, identity, kind, signal)
      const projects = await pool.query(`SELECT id,name,status,priority,start_date,deadline,done_at,contact_name,summary,stages_json
        FROM projects WHERE user_id=$1 AND deleted_at IS NULL AND archived=false AND status IN ('pending','active','done')`, [identity.ownerId])
      const order = { high: 3, medium: 2, low: 1 } as Record<string, number>
      const groups = ['pending', 'active', 'done'].flatMap(status => projects.rows.filter(row => row.status === status).sort((a,b) => {
        const priority = (order[b.priority] ?? 0) - (order[a.priority] ?? 0)
        if (priority) return priority
        const compare = status === 'done' ? (b.done_at ? new Date(b.done_at).getTime() : 0) - (a.done_at ? new Date(a.done_at).getTime() : 0)
          : String(status === 'active' ? a.deadline ?? '' : a.start_date ?? '').localeCompare(String(status === 'active' ? b.deadline ?? '' : b.start_date ?? ''))
        return compare || Number(a.id) - Number(b.id)
      }).slice(0, status === 'pending' ? 5 : status === 'active' ? 10 : 3))
      const ids = groups.map(row => row.id)
      const overviews = await loadAgentProjectOverviews(pool, identity.ownerId, ids)
      signal?.throwIfAborted()
      return groups.map(row => {
        const stages = JSON.parse(row.stages_json) as Array<{done?: boolean}>
        if (!Array.isArray(stages)) throw new Error('项目阶段无效')
        const overview = overviews.get(row.id)!
        return { id: row.id, name: row.name, status: row.status, deadline: row.deadline, contact: row.contact_name, summary: row.summary, stagesDone: stages.filter(stage => stage.done).length, stagesTotal: stages.length, roots: overview.roots, totalFiles: overview.total_file_count, rootFiles: overview.root_file_count, totalFolders: overview.total_folder_count }
      }) as Json
    },
    async loadEvents(identity, timezone, signal) {
      await owned(pool, identity, kind, signal)
      const today = dateKeyInTimeZone(now(), timezone)
      const result = await pool.query('SELECT date,title FROM calendar_events WHERE user_id=$1 AND deleted_at IS NULL AND date >= $2 ORDER BY date LIMIT 10', [identity.ownerId, today])
      signal?.throwIfAborted(); return result.rows as Json
    },
    async loadNotes(identity, signal) {
      await owned(pool, identity, kind, signal)
      const result = await pool.query(`SELECT title,content_plain,content_md,captured_at FROM mind_nodes WHERE user_id=$1 AND kind='note' AND deleted_at IS NULL AND captured_at >= $2 ORDER BY captured_at DESC,id DESC LIMIT 20`, [identity.ownerId, new Date(now().getTime() - 7*86400000)])
      signal?.throwIfAborted()
      return result.rows.map(row => ({ title: String(row.title ?? '').trim(), content: Array.from(String(row.content_plain || row.content_md || '').trim()).slice(0,500).join(''), capturedAt: new Date(row.captured_at).toISOString() })) as Json
    },
    async loadFilesOverview(identity, signal) {
      await owned(pool, identity, kind, signal)
      const folders = (await pool.query(`SELECT id,name FROM folders WHERE user_id=$1 AND project_id IS NULL AND workspace_directory_id IS NULL AND parent_id IS NULL AND deleted_at IS NULL ORDER BY id`, [identity.ownerId])).rows
      const counts = (await pool.query(`SELECT folder_id,count(*)::int AS n FROM files WHERE user_id=$1 AND space='personal' AND deleted_at IS NULL AND folder_id IS NOT NULL GROUP BY folder_id`, [identity.ownerId])).rows
      const totals = (await pool.query(`SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS total,count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS trash FROM files WHERE user_id=$1 AND space='personal'`, [identity.ownerId])).rows[0]
      const files = (await pool.query(`SELECT id,display_name,ext,folder_id,project_id FROM files WHERE user_id=$1 AND space='personal' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 20`, [identity.ownerId])).rows
      signal?.throwIfAborted()
      return { total: totals.total, trash: totals.trash, folders: folders.map(row => ({ id: row.id, name: row.name, path: row.name, project_id: null, parent_id: null, file_count: counts.find(count => count.folder_id === row.id)?.n ?? 0 })), files: files.map(row => ({ id: row.id, name: `${row.display_name}.${row.ext}`, space: 'personal', folder: folders.find(folder => folder.id === row.folder_id)?.name ?? null, project_id: row.project_id })) } as Json
    },
  }
}
