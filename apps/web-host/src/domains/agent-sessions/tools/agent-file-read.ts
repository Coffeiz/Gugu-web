import type { Pool, QueryResultRow } from 'pg'
import type { RunIdentity } from '@gugu/core/agent'
import { openLocalFile } from '@gugu/fs/node'
import type { ReadFilePorts } from '@gugu/core/tools'
import { isOwnedFileStorageKey } from '../../files/file-owner.js'
import type { AgentDispatchLease } from '../persistence/agent-run-dispatch-postgres.js'

const TEXT_EXTENSIONS = new Set([
  'md', 'txt', 'json', 'csv', 'yaml', 'yml', 'log', 'py', 'js', 'ts', 'tsx', 'jsx', 'vue', 'html', 'css', 'scss',
  'java', 'go', 'rs', 'c', 'cpp', 'h', 'hpp', 'sh', 'sql', 'xml', 'toml', 'ini', 'conf', 'env', 'tex', 'svg',
])

type FileRow = QueryResultRow & {
  id: number | string
  user_id: string
  storage_key: string
  display_name: string
  ext: string
}

/** File ID 始终由 owner-scoped PostgreSQL 行解析；磁盘读取只使用 packages/fs 授权根。 */
export function createWebAgentFileReadPort(
  pool: Pick<Pool, 'query'>,
  storageRoot: string,
  lease: AgentDispatchLease,
): ReadFilePorts {
  const expected = Object.freeze({ ...lease.identity })
  const matchesLease = (identity: RunIdentity) => identity.ownerId === expected.ownerId
    && identity.sessionId === expected.sessionId && identity.runId === expected.runId

  return {
    async resolveOwnedFile(identity, id, signal) {
      signal.throwIfAborted()
      if (!matchesLease(identity) || !Number.isSafeInteger(id) || id < 1) return null
      const result = await pool.query<FileRow>(`SELECT id,user_id,storage_key,display_name,ext
        FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [id, expected.ownerId])
      signal.throwIfAborted()
      const row = result.rows[0]
      if (!row || String(row.user_id).toLowerCase() !== expected.ownerId.toLowerCase()
        || !isOwnedFileStorageKey(expected.ownerId, row.storage_key)) return null
      const ext = String(row.ext ?? '').toLowerCase()
      const extensionless = !ext || ext === 'file'
      const base = String(row.display_name ?? '')
      const name = extensionless ? base : `${base}.${ext}`
      return {
        id: Number(row.id), name, root: storageRoot, relativePath: row.storage_key,
        text: TEXT_EXTENSIONS.has(ext), extensionless,
      }
    },
    async openFile(root, relativePath) {
      return openLocalFile(root, relativePath)
    },
  }
}
