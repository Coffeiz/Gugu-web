import type { Pool } from 'pg'
import type { TrashListItem, TrashListPort } from '@gugu/core/tools'
import { createPostgresAgentTrashReader } from '../../files/persistence/trash-postgres.js'

/** 只装配既有回收站只读服务，不接收模型提供的owner、游标或凭据。 */
export function createAgentTrashListPort(pool: Pool, secret: string): TrashListPort {
  const reader = createPostgresAgentTrashReader(pool, secret)
  return {
    async list(identity, limit, signal) {
      signal.throwIfAborted()
      const files = await reader.listFiles(identity.ownerId, { limit, cursor: null })
      signal.throwIfAborted()
      const folders = await reader.listFolders(identity.ownerId, { limit, cursor: null })
      signal.throwIfAborted()
      // 领域工厂固定采用Agent投影；不接受任意分页来源或模型自定义字段。
      return { files: files.items as unknown as TrashListItem[], folders: folders.items as unknown as TrashListItem[] }
    },
  }
}
