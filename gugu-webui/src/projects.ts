import { dataContext } from '@gugu/core'
import type { SqlDataRuntime } from '@gugu/core/data'
import type { Pool } from 'pg'

export function createProjectListing(core: SqlDataRuntime, pool: Pool) {
  return async (ownerId: string, archived: boolean): Promise<unknown[]> => {
    const projects = await core.transaction(
      dataContext(ownerId),
      (data) => data.projects.list(archived),
    )
    if (projects.length === 0) return []
    const ids = projects.map((project) => project.id)
    const counts = await pool.query<{ project_id: number; file_count: string }>(
      `SELECT counts.project_id, counts.file_count
       FROM project_file_counts AS counts
       JOIN projects ON projects.id = counts.project_id
       WHERE projects.user_id = $1 AND counts.project_id = ANY($2::integer[])`,
      [ownerId, ids],
    )
    const fileCounts = new Map(counts.rows.map((row) => [row.project_id, Number(row.file_count)]))
    return projects.map((project) => ({
      id: project.id,
      name: project.name,
      client: project.client,
      status: project.status,
      startDate: project.start_date,
      deadline: project.deadline,
      color: project.color,
      progress: project.progress,
      stages: JSON.parse(project.stages_json),
      currentStage: project.current_stage,
      archived: project.archived,
      priority: project.priority,
      version: project.version || 1,
      doneAt: project.done_at,
      updatedAt: project.updated_at,
      deletedAt: project.deleted_at,
      createdAt: project.created_at.slice(0, 10),
      fileCount: fileCounts.get(project.id) ?? 0,
    }))
  }
}
