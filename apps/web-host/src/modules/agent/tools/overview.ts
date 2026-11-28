import { readWebProjectWorkspaceLinks } from '../../workspaces/project-links.js'
import type { Pool } from 'pg'
import type { RunIdentity } from '@gugu/core/agent'
import { sandboxTarget } from '../../workspaces/roots.js'
import { readPathDirectoryOverview, resolveFileDirectoryRoot } from '../../workspaces/files.js'

/** 只接受可信运行身份及已解析的项目；等待数据库查询结束后再传播取消。 */
export function createProjectFileOverviewPort(pool: Pick<Pool, 'query'>, storageRoot: string) {
  return async (identity: RunIdentity, projectId: number, signal: AbortSignal) => {
    signal.throwIfAborted()
    try {
      const workspaces = await readWebProjectWorkspaceLinks(pool, identity.ownerId, projectId)
      const active = workspaces.find(workspace => workspace.active)
      const key = await resolveFileDirectoryRoot(pool, identity.ownerId, active?.directoryId ?? { projectId })
      const counts = await readPathDirectoryOverview(storageRoot, key, signal)
      return { ...(workspaces.length ? { workspaces } : {}), total_file_count: counts.total, root_file_count: counts.rootFiles, total_folder_count: counts.totalFolders, location: { kind: 'sandbox' as const, value: sandboxTarget(key) } }
    }
    finally { signal.throwIfAborted() }
  }
}
