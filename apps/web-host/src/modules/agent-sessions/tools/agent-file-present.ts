import type { Pool, QueryResultRow } from 'pg'
import type { FilePresentationPort, FilePresentationResolution, FileGrepPort, FileGrepCandidate } from '@gugu/core/tools'
import type { RunIdentity } from '@gugu/core/agent'
import { isOwnedFileStorageKey } from '../../files/file-owner.js'
import type { AgentDispatchLease } from '../persistence/agent-run-dispatch-postgres.js'

type FileRow = QueryResultRow & {
  id: number | string
  user_id: string
  storage_key: string
  display_name: string
  ext: string | null
  space?: string
  folder_id?: number | string | null
}

/** Web-only 文件展示解析；展示结果只携带文件 ID，实际内容仍走现有 owner 文件读取路由。 */
export function createWebAgentFilePresentPort(options: {
  pool: Pick<Pool, 'query'>
  ownerId: string
  lease: AgentDispatchLease
  files: FileGrepPort
}): FilePresentationPort {
  const expected = Object.freeze({ ...options.lease.identity })
  if (options.lease.input.v !== 2 || options.lease.input.source !== 'web'
    || expected.ownerId !== options.ownerId) throw new TypeError('Web Agent 文件展示来源无法验证')
  const matchesLease = (identity: RunIdentity) => identity.ownerId === expected.ownerId
    && identity.sessionId === expected.sessionId && identity.runId === expected.runId
  const present = (row: FileRow): FilePresentationResolution => {
    if (!Number.isSafeInteger(Number(row.id)) || Number(row.id) <= 0
      || !isOwnedFileStorageKey(expected.ownerId, row.storage_key)) return { error: '文件不存在' }
    return { file: { file_id: Number(row.id), name: String(row.display_name ?? ''), ext: String(row.ext ?? '') } }
  }
  const candidates = (rows: readonly FileRow[]): FilePresentationResolution => {
    if (rows.length === 1) return present(rows[0]!)
    if (!rows.length) return { error: '未找到文件' }
    return { error: '有多个匹配文件，请指定 file_id', candidates: rows.slice(0, 10).map(row => ({
      id: Number(row.id), name: `${row.display_name}${row.ext ? `.${row.ext}` : ''}`,
      ...(row.space ? { space: row.space } : {}), ...(row.folder_id != null ? { folder_id: Number(row.folder_id) } : {}),
    })) }
  }

  return {
    async resolve(identity, selector, signal) {
      signal.throwIfAborted()
      if (!matchesLease(identity)) return { error: '文件不存在' }
      if (selector.file_id !== undefined) {
        const result = await options.pool.query<FileRow>(`SELECT id,user_id,storage_key,display_name,ext
          FROM files WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [selector.file_id, expected.ownerId])
        signal.throwIfAborted()
        const row = result.rows[0]
        return row && String(row.user_id).toLowerCase() === expected.ownerId.toLowerCase() ? present(row) : { error: '文件不存在' }
      }

      const name = String(selector.file ?? '').trim()
      if (!name) return { error: '需提供 file_id 或文件名 file' }
      if (name.startsWith('file://')) return { error: '不接受 file:// 本地 URI；请使用 /personal、/project 或 /workspace 下的逻辑路径。' }
      if (name.startsWith('/')) {
        const parts = name.slice(1).split('/')
        if (name.includes('\\') || name.includes('\0') || parts.some(part => !part || part === '.' || part === '..'))
          return { error: '路径不能包含空目录、. 或 ..' }
        if (!['personal', 'project', 'workspace'].includes(parts[0] ?? '')) return { error: '路径只允许 /personal、/project 或 /workspace' }
        if (parts.length < 2) return { error: '文件路径还需要包含文件名' }
        const files = await options.files.list(identity, signal)
        signal.throwIfAborted()
        const matches = files.filter((file: FileGrepCandidate) => file.path === name)
        if (matches.length === 1) {
          const file = matches[0]!
          const extension = file.name.lastIndexOf('.')
          return { file: { file_id: file.file_id,
            name: file.name.slice(0, extension > 0 ? extension : undefined),
            ext: extension > 0 ? file.name.slice(extension + 1) : '' } }
        }
        if (matches.length > 1) return { error: '逻辑路径匹配到多个文件记录，请用 file_id 指定。', candidates: matches.slice(0, 10).map(file => ({
          id: file.file_id, name: file.name,
        })) }
        return { error: '逻辑路径未匹配到已登记的文件；请先用 list_dir 确认路径和文件是否已同步。' }
      }

      const baseName = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name
      const exact = await options.pool.query<FileRow>(`SELECT id,user_id,storage_key,display_name,ext,space,folder_id
        FROM files WHERE user_id=$1 AND deleted_at IS NULL AND display_name=$2 ORDER BY id LIMIT 11`, [expected.ownerId, baseName])
      signal.throwIfAborted()
      if (exact.rows.length) return candidates(exact.rows)
      const fuzzy = await options.pool.query<FileRow>(`SELECT id,user_id,storage_key,display_name,ext,space,folder_id
        FROM files WHERE user_id=$1 AND deleted_at IS NULL AND display_name ILIKE $2 ORDER BY id LIMIT 11`, [expected.ownerId, `%${baseName}%`])
      signal.throwIfAborted()
      return fuzzy.rows.length ? candidates(fuzzy.rows) : { error: `未找到文件「${name}」` }
    },
  }
}
