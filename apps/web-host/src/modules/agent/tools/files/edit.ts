import type { Pool, QueryResultRow } from 'pg'
import type { RunIdentity } from '@gugu/core/agent'
import type { FileEditPort, FileGrepPort } from '@gugu/core/tools'
import { openLocalFile } from '@gugu/fs/node'
import type { FileContentOperations } from '../../../files/content.js'
import { isOwnedFileStorageKey } from '../../../files/store.js'
import type { AgentDispatchLease } from '../../run/dispatch.js'

const MAX_BYTES = 256 * 1024
const TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'text', 'json', 'csv', 'tsv', 'yaml', 'yml', 'xml', 'html', 'htm', 'css',
  'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'go', 'rs', 'rb', 'php', 'sh', 'bash',
  'sql', 'ini', 'toml', 'conf', 'log', 'vue', 'svg', 'env', 'm3u', 'm3u8',
])
type FileRow = QueryResultRow & {
  id: number | string
  user_id: string
  storage_key: string
  display_name: string
  ext: string
  mime_type: string | null
  version: number | string
}

/** 通过当前 dispatch lease 解析 owner 文件；正文写入复用文件域 CAS/Undo 事务。 */
export function createWebAgentFileEditPort(
  pool: Pick<Pool, 'query'>,
  storageRoot: string,
  operations: FileContentOperations,
  lease: AgentDispatchLease,
  files?: Pick<FileGrepPort, 'list'>,
): FileEditPort {
  const expected = Object.freeze({ ...lease.identity })
  const matchesLease = (identity: RunIdentity) => identity.ownerId === expected.ownerId
    && identity.sessionId === expected.sessionId && identity.runId === expected.runId
  return {
    async resolveFilePath(identity, path, signal) {
      signal.throwIfAborted()
      if (!files || !matchesLease(identity) || !path.startsWith('/') || path.includes('\\') || path.includes('\0')) return null
      const parts = path.slice(1).split('/')
      if (parts.length < 2 || !['personal', 'project', 'workspace'].includes(parts[0] ?? '')
        || parts.some(part => !part || part === '.' || part === '..')) return null
      const candidates = (await files.list(identity, signal)).filter(file => file.path === path)
      signal.throwIfAborted()
      return candidates.length === 1 ? candidates[0]!.file_id : null
    },
    async read(identity, id, signal) {
      signal.throwIfAborted()
      if (!matchesLease(identity) || !Number.isSafeInteger(id) || id < 1) return null
      const result = await pool.query<FileRow>(`SELECT id,user_id,storage_key,display_name,ext,mime_type,version
        FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [id, expected.ownerId])
      signal.throwIfAborted()
      const row = result.rows[0]
      if (!row || String(row.user_id).toLowerCase() !== expected.ownerId.toLowerCase()
        || !isOwnedFileStorageKey(expected.ownerId, row.storage_key)) return null
      const ext = String(row.ext ?? '').toLowerCase()
      const mime = String(row.mime_type ?? '').toLowerCase()
      if (!TEXT_EXTENSIONS.has(ext) && !mime.startsWith('text/')
        && !['application/json', 'application/xml', 'application/javascript', 'application/typescript', 'application/sql', 'application/x-sh'].includes(mime)
        && !mime.endsWith('+json') && !mime.endsWith('+xml')) throw new Error('仅文本类文件可编辑')
      const opened = await openLocalFile(storageRoot, row.storage_key)
      if (!opened) return null
      try {
        signal.throwIfAborted()
        if (opened.size > MAX_BYTES) throw new Error('文件过大，超出可改上限 256KB')
        const bytes = new Uint8Array(MAX_BYTES + 1)
        let size = 0
        while (size < bytes.length) {
          signal.throwIfAborted()
          const read = await opened.handle.read(bytes, size, Math.min(65536, bytes.length - size), size)
          if (!read.bytesRead) break
          size += read.bytesRead
        }
        signal.throwIfAborted()
        if (size > MAX_BYTES) throw new Error('文件过大，超出可改上限 256KB')
        let content: string
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)) }
        catch { throw new Error('内容不是 UTF-8 文本') }
        return { id: Number(row.id), name: ext ? `${row.display_name}.${ext}` : String(row.display_name), content, version: Number(row.version) }
      } finally { await opened.handle.close() }
    },
    async update(identity, id, content, version, signal) {
      signal.throwIfAborted()
      if (!matchesLease(identity)) throw new Error('文件编辑授权已失效')
      const result = await operations.update(expected.ownerId, id, content, version, {
        idempotencyKey: null,
        undoContextId: `agent:${expected.sessionId}:${expected.runId}`.slice(0, 128),
        clientId: null,
      })
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('文件编辑失败')
      const row = result as Record<string, unknown>
      if (!Number.isSafeInteger(row.version) || !Number.isSafeInteger(row.sizeBytes)) throw new Error('文件编辑失败')
      return { version: Number(row.version), size_bytes: Number(row.sizeBytes) }
    },
  }
}
