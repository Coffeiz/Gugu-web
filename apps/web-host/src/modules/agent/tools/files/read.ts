import type { Pool, QueryResultRow } from 'pg'
import type { RunIdentity } from '@gugu/core/agent'
import { openLocalFile } from '@gugu/fs/node'
import type { FilePathLookup, ReadFilePorts } from '@gugu/core/tools'
import { isOwnedFileStorageKey } from '../../../files/store.js'
import type { AgentDispatchLease } from '../../run/dispatch.js'

const TEXT_EXTENSIONS = new Set([
  'md', 'txt', 'json', 'csv', 'yaml', 'yml', 'log', 'py', 'js', 'ts', 'tsx', 'jsx', 'vue', 'html', 'css', 'scss',
  'java', 'go', 'rs', 'c', 'cpp', 'h', 'hpp', 'sh', 'sql', 'xml', 'toml', 'ini', 'conf', 'env', 'tex', 'svg',
])

export function webAgentFileTextType(ext: string) {
  const extension = ext.toLowerCase()
  return { text: TEXT_EXTENSIONS.has(extension), extensionless: !extension || extension === 'file', extension }
}

type FileRow = QueryResultRow & {
  user_id: string
  path: string
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

/** 路径先经 owner 文件列表确认，再只通过 packages/fs 的授权根读取。 */
export function createWebAgentFileReadPort(
  pool: Pick<Pool, 'query'>,
  storageRoot: string,
  lease: Pick<AgentDispatchLease, 'identity'>,
  files?: FilePathLookup,
): ReadFilePorts {
  const expected = Object.freeze({ ...lease.identity })
  const matchesLease = (identity: RunIdentity) => identity.ownerId === expected.ownerId
    && identity.sessionId === expected.sessionId && identity.runId === expected.runId

  return {
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
      const result = await pool.query<FileRow>(`SELECT user_id,path,display_name,ext
        FROM files WHERE path=$1 AND user_id=$2 AND deleted_at IS NULL`, [matched[0]!.storageKey, expected.ownerId])
      signal.throwIfAborted()
      const row = result.rows[0]
      if (!row || String(row.user_id).toLowerCase() !== expected.ownerId.toLowerCase()
        || !isOwnedFileStorageKey(expected.ownerId, row.path)) return null
      const type = webAgentFileTextType(String(row.ext ?? ''))
      const base = String(row.display_name ?? '')
      const name = type.extensionless ? base : `${base}.${type.extension}`
      return { name, root: storageRoot, relativePath: row.path, ...type }
    },
    async openFile(root, relativePath) {
      return openLocalFile(root, relativePath)
    },
  }
}
