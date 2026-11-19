import type { Pool } from 'pg'
import type { RunIdentity } from '@gugu/core/agent'
import { readProjectFileOverview } from '../../projects/store.js'

/** 只接受可信运行身份及已解析的项目；等待数据库查询结束后再传播取消。 */
export function createProjectFileOverviewPort(pool: Pick<Pool, 'query'>) {
  return async (identity: RunIdentity, projectId: number, signal: AbortSignal) => {
    signal.throwIfAborted()
    try { return await readProjectFileOverview(pool, identity.ownerId, projectId) }
    finally { signal.throwIfAborted() }
  }
}
