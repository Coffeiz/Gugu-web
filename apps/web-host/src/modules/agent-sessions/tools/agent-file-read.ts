import type { Pool, QueryResultRow } from 'pg'
import type { RunIdentity } from '@gugu/core/agent'
import { openLocalFile } from '@gugu/fs/node'
import type { FileGrepPort, ReadFilePorts } from '@gugu/core/tools'
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
type ChatAttachmentRow = QueryResultRow & {
  attach_id: string
  user_id: string
  storage_key: string
  name: string
  ext: string
  kind: string
  size: number | string
}

/** File ID 始终由 owner-scoped PostgreSQL 行解析；磁盘读取只使用 packages/fs 授权根。 */
export function createWebAgentFileReadPort(
  pool: Pick<Pool, 'query'>,
  storageRoot: string,
  lease: AgentDispatchLease,
  files?: FileGrepPort,
): ReadFilePorts {
  const expected = Object.freeze({ ...lease.identity })
  const matchesLease = (identity: RunIdentity) => identity.ownerId === expected.ownerId
    && identity.sessionId === expected.sessionId && identity.runId === expected.runId

  const resolveOwnedFile: ReadFilePorts['resolveOwnedFile'] = async (identity, id, signal) => {
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
        text: TEXT_EXTENSIONS.has(ext), extensionless, extension: ext,
      }
  }

  return {
    resolveOwnedFile,
    async resolveOwnedAttachment(identity, attachId, signal) {
      signal.throwIfAborted()
      if (!matchesLease(identity) || !attachId.trim() || attachId.length > 256) return null
      const result = await pool.query<ChatAttachmentRow>(`SELECT attach_id,user_id,storage_key,name,ext,kind,size
        FROM chat_attachments WHERE attach_id=$1 AND user_id=$2`, [attachId, expected.ownerId])
      signal.throwIfAborted()
      const row = result.rows[0]
      if (!row || String(row.user_id).toLowerCase() !== expected.ownerId.toLowerCase()
        || row.attach_id !== attachId || !isOwnedFileStorageKey(expected.ownerId, row.storage_key)) return null
      const sizeBytes = Number(row.size)
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) return null
      return {
        attach_id: row.attach_id,
        name: String(row.name || '聊天附件'),
        kind: String(row.kind || '').toLowerCase(),
        extension: String(row.ext || '').toLowerCase(),
        size_bytes: sizeBytes,
        root: storageRoot,
        relativePath: row.storage_key,
      }
    },
    async resolveFilePath(identity, path, signal) {
      signal.throwIfAborted()
      if (!files || !matchesLease(identity) || !path.startsWith('/') || path.includes('\\') || path.includes('\0')) return null
      const parts = path.slice(1).split('/')
      if (parts.length < 2 || !['personal', 'project', 'workspace'].includes(parts[0] ?? '')
        || parts.some(part => !part || part === '.' || part === '..')) return null
      const matched = (await files.list(identity, signal)).filter(file => file.path === path)
      signal.throwIfAborted()
      if (matched.length !== 1) return null
      return resolveOwnedFile(identity, matched[0]!.file_id, signal)
    },
    async openFile(root, relativePath) {
      return openLocalFile(root, relativePath)
    },
  }
}
