import { readPathDirectoryOverview } from '../../workspaces/files.js'
import { projectFilePath } from '../../files/paths.js'
import { personalFileRootPath } from '../../workspaces/roots.js'
import type { Pool } from 'pg'
import type { ContextDataPorts, HistoryIdentity, Json } from '@gugu/core/agent'
import { agentContextSubject } from './subject.js'
import { dateKeyInTimeZone } from '../../../shared/date-time.js'

type QueryPool = Pick<Pool, 'query'>
async function owned(pool: QueryPool, identity: HistoryIdentity, kind: 'chat' | 'scheduled_task', signal?: AbortSignal) {
  signal?.throwIfAborted()
  const subject = agentContextSubject(kind, identity)
  const result = await pool.query(`SELECT 1 FROM ${subject.from} AS s WHERE s.id=$1 AND s.user_id=$2`, [subject.id, identity.ownerId])
  if (result.rowCount !== 1) throw new Error(subject.missing)
  signal?.throwIfAborted()
}

/** 数据读取严格限定 owner；只返回模型快照所需的受限概览。 */
export function createAgentOverviewSources(pool: QueryPool, storageRoot: string, now: () => Date = () => new Date(), kind: 'chat' | 'scheduled_task' = 'chat'): Pick<ContextDataPorts, 'loadProjects' | 'loadEvents' | 'loadNotes' | 'loadFilesOverview'> {
  return {
    async loadProjects(identity, signal) {
      await owned(pool, identity, kind, signal)
      const projects = await pool.query(`SELECT id,name,status,priority,start_date,created_at,deadline,done_at,contact_name,summary,stages_json
        FROM projects WHERE user_id=$1 AND deleted_at IS NULL AND archived=false AND status IN ('pending','active','done')`, [identity.ownerId])
      const order = { high: 3, medium: 2, low: 1 } as Record<string, number>
      const groups = ['pending', 'active', 'done'].flatMap(status => projects.rows.filter(row => row.status === status).sort((a,b) => {
        const priority = (order[b.priority] ?? 0) - (order[a.priority] ?? 0)
        if (priority) return priority
        const compare = status === 'done' ? (b.done_at ? new Date(b.done_at).getTime() : 0) - (a.done_at ? new Date(a.done_at).getTime() : 0)
          : String(status === 'active' ? a.deadline ?? '' : a.start_date ?? '').localeCompare(String(status === 'active' ? b.deadline ?? '' : b.start_date ?? ''))
        return compare || Number(a.id) - Number(b.id)
      }).slice(0, status === 'pending' ? 5 : status === 'active' ? 10 : 3))
      return await Promise.all(groups.map(async row => {
        const key = projectFilePath(identity.ownerId, Number(row.id), row.name, row.start_date, row.created_at)
        const overview = await readPathDirectoryOverview(storageRoot, key, signal)
        const stages = JSON.parse(row.stages_json) as Array<{done?: boolean}>
        if (!Array.isArray(stages)) throw new Error('项目阶段无效')
        return { id: row.id, name: row.name, status: row.status, deadline: row.deadline, contact: row.contact_name, summary: row.summary, stagesDone: stages.filter(stage => stage.done).length, stagesTotal: stages.length, roots: overview.folders.map(folder => folder.name), totalFiles: overview.total, rootFiles: overview.rootFiles, totalFolders: overview.totalFolders }
      })) as Json
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
      const { total, folders, files } = await readPathDirectoryOverview(storageRoot, personalFileRootPath(identity.ownerId), signal)
      signal?.throwIfAborted()
      return { total, folders, files } as Json
    },
  }
}
