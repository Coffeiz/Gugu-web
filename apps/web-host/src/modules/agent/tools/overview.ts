import type { Pool } from 'pg'
import type { RunIdentity } from '@gugu/core/agent'
import { readPostgresProjectPathMirrorKey } from '../../files/folders/paths.js'
import { sandboxTarget } from '../../terminals/sandbox/mounts.js'
import { readProjectFileOverview } from '../../projects/store.js'

/** 只接受可信运行身份及已解析的项目；等待数据库查询结束后再传播取消。 */
export function createProjectFileOverviewPort(pool: Pick<Pool, 'query'>) {
  return async (identity: RunIdentity, projectId: number, signal: AbortSignal) => {
    signal.throwIfAborted()
    try {
      const key = await readPostgresProjectPathMirrorKey(pool, identity.ownerId, projectId)
      signal.throwIfAborted()
      const counts = await readProjectFileOverview(pool, identity.ownerId, projectId)
      return { ...counts, sandbox_path: sandboxTarget(key) }
    }
    finally { signal.throwIfAborted() }
  }
}
