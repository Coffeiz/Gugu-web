import type { FileGrepCandidate, FileGrepPort } from '@gugu/core/tools'
import { openLocalFile } from '@gugu/fs/node'
import type { Pool, QueryResultRow } from 'pg'
import type { RunIdentity } from '@gugu/core/agent'
import { isOwnedFileStorageKey } from '../../../files/store.js'
import type { AgentDispatchLease } from '../../run/dispatch.js'

const MAX_FILE_BYTES = 4 * 1024 * 1024
const TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'text', 'json', 'csv', 'tsv', 'yaml', 'yml', 'xml', 'html', 'htm', 'css', 'js', 'ts',
  'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'go', 'rs', 'rb', 'php', 'sh', 'bash', 'sql', 'ini', 'toml',
  'conf', 'log', 'vue', 'svg', 'env', 'm3u', 'm3u8',
])
const TEXT_MIMES = new Set(['application/json', 'application/xml', 'application/javascript', 'application/typescript', 'application/sql', 'application/x-sh'])

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
  size_bytes: number | string | null
  mime_type: string | null
}
type ReadRow = QueryResultRow & { storage_key: string; ext: string | null; mime_type: string | null; size_bytes: number | string | null }

function safeComponent(value: unknown): string {
  return String(value ?? '').replace(/[\\/]/gu, '_').trim()
}

function isTextRecord(ext: string | null, mime: string | null): boolean {
  const normalizedExt = (ext ?? '').toLowerCase()
  const normalizedMime = (mime ?? '').toLowerCase()
  return TEXT_EXTENSIONS.has(normalizedExt) || normalizedMime.startsWith('text/') || TEXT_MIMES.has(normalizedMime)
    || normalizedMime.endsWith('+json') || normalizedMime.endsWith('+xml')
}

function matchesLease(identity: RunIdentity, expected: RunIdentity): boolean {
  return identity.ownerId === expected.ownerId && identity.sessionId === expected.sessionId && identity.runId === expected.runId
}

/** grep 复用 owner 文件记录与 packages/fs 授权根，不接受模型传入的物理路径。 */
export function createWebAgentFileGrepPort(
  pool: Pick<Pool, 'query'>,
  storageRoot: string,
  lease: AgentDispatchLease,
): FileGrepPort {
  const expected = Object.freeze({ ...lease.identity })
  if (lease.input.v !== 2 || lease.input.source !== 'web') throw new TypeError('Web Agent 文件搜索来源无法验证')
  const owner = expected.ownerId

  return {
    async list(identity, signal): Promise<readonly FileGrepCandidate[]> {
      signal.throwIfAborted()
      if (!matchesLease(identity, expected)) throw new Error('文件搜索授权已失效')
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
          project.name AS project_name,workspace.directory_name,folder.relative_path AS folder_path,
          file.size_bytes,file.mime_type
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
        const space = row.space as FileGrepCandidate['space']
        const base = space === 'project' ? (row.project_name ? `/project/${safeComponent(row.project_name)}` : null)
          : space === 'workspace' ? (row.directory_name ? `/workspace/${safeComponent(row.directory_name)}` : null) : '/personal'
        const filename = `${String(row.display_name ?? '')}${row.ext ? `.${row.ext}` : ''}`
        const folder = row.folder_id === null ? '' : row.folder_path ? `/${row.folder_path.split('/').map(safeComponent).join('/')}` : null
        const path = base === null || folder === null ? null : `${base}${folder}/${safeComponent(filename)}`
        return {
          file_id: Number(row.id), name: filename, space, path,
          project_id: row.project_id === null ? null : Number(row.project_id),
          folder_id: row.folder_id === null ? null : Number(row.folder_id),
          workspace_directory_id: row.workspace_directory_id === null ? null : Number(row.workspace_directory_id),
          size_bytes: Number(row.size_bytes ?? 0), is_text: isTextRecord(row.ext, row.mime_type),
        }
      })
    },
    async readText(identity, fileId, signal) {
      signal.throwIfAborted()
      if (!matchesLease(identity, expected) || !Number.isSafeInteger(fileId) || fileId < 1) return null
      const result = await pool.query<ReadRow>(`SELECT storage_key,ext,mime_type,size_bytes FROM files
        WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL AND space IN ('personal','project','workspace')`, [fileId, owner])
      signal.throwIfAborted()
      const row = result.rows[0]
      if (!row || !isOwnedFileStorageKey(owner, row.storage_key) || !isTextRecord(row.ext, row.mime_type)
        || Number(row.size_bytes ?? 0) > MAX_FILE_BYTES) return null
      const opened = await openLocalFile(storageRoot, row.storage_key)
      if (!opened) return null
      try {
        signal.throwIfAborted()
        if (opened.size > MAX_FILE_BYTES) return null
        const bytes = new Uint8Array(Math.min(MAX_FILE_BYTES, opened.size) + 1)
        let size = 0
        while (size < bytes.length) {
          signal.throwIfAborted()
          const read = await opened.handle.read(bytes, size, Math.min(64 * 1024, bytes.length - size), size)
          if (!read.bytesRead) break
          size += read.bytesRead
        }
        signal.throwIfAborted()
        if (size > MAX_FILE_BYTES) return null
        try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)) }
        catch { return null }
      } finally { await opened.handle.close() }
    },
  }
}
