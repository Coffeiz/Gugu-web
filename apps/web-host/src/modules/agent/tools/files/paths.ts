import type { FilePathCandidate, FilePathLookup } from '@gugu/core/tools'
import type { Pool, QueryResultRow } from 'pg'
import type { RunIdentity } from '@gugu/core/agent'
import type { AgentDispatchLease } from '../../run/dispatch.js'

type CandidateRow = QueryResultRow & {
  id: number | string
  display_name: string
  ext: string | null
  space: string
  project_id: number | string | null
  folder_id: number | string | null
  workspace_directory_id: number | string | null
  project_name: string | null
  directory_name: string | null
  folder_path: string | null
}
function safeComponent(value: unknown): string {
  return String(value ?? '').replace(/[\\/]/gu, '_').trim()
}

function matchesLease(identity: RunIdentity, expected: RunIdentity): boolean {
  return identity.ownerId === expected.ownerId && identity.sessionId === expected.sessionId && identity.runId === expected.runId
}

/** 根据当前用户的登记记录解析文件库路径。 */
export function createWebAgentFilePathLookup(pool: Pick<Pool, 'query'>, lease: AgentDispatchLease): FilePathLookup {
  const expected = Object.freeze({ ...lease.identity })
  if (lease.input.v !== 2 || lease.input.source !== 'web') throw new TypeError('Web Agent 文件路径解析来源无法验证')
  const owner = expected.ownerId

  return {
    async list(identity, signal): Promise<readonly FilePathCandidate[]> {
      signal.throwIfAborted()
      if (!matchesLease(identity, expected)) throw new Error('文件路径解析授权已失效')
      const result = await pool.query<CandidateRow>(`WITH RECURSIVE folder_paths AS (
          SELECT id,user_id,project_id,workspace_directory_id,parent_id,name,name::text AS relative_path,0 AS depth
          FROM folders WHERE user_id=$1 AND deleted_at IS NULL AND parent_id IS NULL
          UNION ALL
          SELECT child.id,child.user_id,child.project_id,child.workspace_directory_id,child.parent_id,child.name,
            parent.relative_path || '/' || child.name,parent.depth+1
          FROM folders child JOIN folder_paths parent ON child.parent_id=parent.id AND child.user_id=parent.user_id
            AND child.project_id IS NOT DISTINCT FROM parent.project_id
            AND child.workspace_directory_id IS NOT DISTINCT FROM parent.workspace_directory_id
          WHERE child.deleted_at IS NULL AND parent.depth<64
        )
        SELECT file.id,file.display_name,file.ext,file.space,file.project_id,file.folder_id,file.workspace_directory_id,
          project.name AS project_name,workspace.directory_name,folder.relative_path AS folder_path
        FROM files file
        LEFT JOIN projects project ON project.id=file.project_id AND project.user_id=file.user_id
        LEFT JOIN workspace_directories workspace ON workspace.id=file.workspace_directory_id AND workspace.user_id=file.user_id
          AND workspace.deleted_at IS NULL
        LEFT JOIN folder_paths folder ON folder.id=file.folder_id AND folder.user_id=file.user_id
        WHERE file.user_id=$1 AND file.deleted_at IS NULL AND file.space IN ('personal','project','workspace')
          AND ((file.space='personal' AND file.project_id IS NULL AND file.workspace_directory_id IS NULL)
            OR (file.space='project' AND file.project_id IS NOT NULL AND file.workspace_directory_id IS NULL AND project.id IS NOT NULL)
            OR (file.space='workspace' AND file.workspace_directory_id IS NOT NULL AND file.project_id IS NULL AND workspace.id IS NOT NULL))
        ORDER BY file.updated_at DESC,file.id DESC`, [owner])
      signal.throwIfAborted()
      return result.rows.map(row => {
        const space = row.space
        const base = space === 'project' ? (row.project_name ? `/project/${safeComponent(row.project_name)}` : null)
          : space === 'workspace' ? (row.directory_name ? `/workspace/${safeComponent(row.directory_name)}` : null) : '/personal'
        const filename = `${String(row.display_name ?? '')}${row.ext ? `.${row.ext}` : ''}`
        const folder = row.folder_id === null ? '' : row.folder_path ? `/${row.folder_path.split('/').map(safeComponent).join('/')}` : null
        const path = base === null || folder === null ? null : `${base}${folder}/${safeComponent(filename)}`
        return { file_id: Number(row.id), name: filename, path }
      })
    },
  }
}
