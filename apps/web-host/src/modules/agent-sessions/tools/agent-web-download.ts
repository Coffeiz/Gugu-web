import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { Pool, PoolClient } from 'pg'
import type { RawBuilder } from 'kysely'
import { extension } from 'mime-types'
import { CoreError } from '@gugu/core'
import { stableJson } from '@gugu/core/agent'
import type { ToolCall, ToolResult, RunIdentity } from '@gugu/core/agent'
import { createWebDownloadTool, resolveWebDownloadLocation, type WebDownloadPort } from '@gugu/core/tools'
import { createSessionWorkspaceTargetReader } from '@gugu/core/workspaces/shell-target'
import type { SqlDataRuntime } from '@gugu/core/data'
import { stageFile, type FileUploadInput } from '../../files/file-upload.js'
import type { createPostgresFileUploadOperations } from '../../files/file-upload-postgres.js'
import { createWebAgentRagRunAuthorization } from './agent-rag-run-authorization.js'
import type { AgentDispatchLease } from '../persistence/agent-run-dispatch-postgres.js'

const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
const WEB_DOWNLOAD_STAGING_PREFIX = 'gugu-web-download-'
const WEB_DOWNLOAD_STAGING_RETENTION_MS = 24 * 60 * 60 * 1000
let webDownloadStagingCleanup: Promise<void> | null = null

/** 只回收本工具、当前 Unix 用户创建且超过保留期的暂存目录；不跟随符号链接。 */
export async function cleanupStaleWebDownloadStaging(options: { root?: string; now?: number; uid?: number } = {}): Promise<number> {
  const uid = options.uid ?? process.getuid?.()
  if (uid === undefined) return 0
  const root = options.root ?? tmpdir()
  const cutoff = (options.now ?? Date.now()) - WEB_DOWNLOAD_STAGING_RETENTION_MS
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return 0 }
  let removed = 0
  for (const entry of entries) {
    if (!entry.name.startsWith(WEB_DOWNLOAD_STAGING_PREFIX) || !entry.isDirectory()) continue
    const target = path.join(root, entry.name)
    try {
      const info = await lstat(target)
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || info.mtimeMs >= cutoff) continue
      await rm(target, { recursive: true, force: true })
      removed++
    } catch { /* 暂存可能已被另一个 Run 删除；不影响当前下载。 */ }
  }
  return removed
}

function ensureWebDownloadStagingCleanup(): Promise<void> {
  webDownloadStagingCleanup ??= cleanupStaleWebDownloadStaging().then(() => undefined).catch(() => undefined)
  return webDownloadStagingCleanup
}

function receipt(identity: RunIdentity & { roundId: string }, call: ToolCall) {
  const hash = digest(['agent.web.download', identity.ownerId, identity.sessionId, identity.runId, identity.roundId, call.id])
  return { operationId: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
    fingerprint: digest(call.input) }
}

type UploadFile = {
  id: number; displayName: string; ext: string; size: string; sizeBytes: number; mimeType: string;
  space: string; projectId: number | null; folderId: number | null
}

function result(value: unknown, mutated: boolean, call: ToolCall): ToolResult {
  const file = value as UploadFile
  const rawUrl = (call.input as { url: string }).url.trim()
  const source = new URL(/^https?:\/\//iu.test(rawUrl) ? rawUrl : `https://${rawUrl}`)
  source.username = ''; source.password = ''; source.search = ''; source.hash = ''
  return { kind: 'completed', successful: true, mutated, value: {
    success: true, file_id: file.id, name: `${file.displayName}.${file.ext}`, size: file.size, size_bytes: file.sizeBytes,
    mime_type: file.mimeType, space: file.space, project_id: file.projectId, folder_id: file.folderId, source_url: source.href,
  } }
}

const failure = (error: string): ToolResult => ({ kind: 'completed', successful: false, mutated: false, value: { error } })
class DownloadLeaseLost extends Error {}
class DownloadTargetChanged extends Error {}

/** Web 下载复用目标解析、流式暂存、配额以及正式文件库事务。 */
export function createWebAgentDownloadTool(options: {
  pool: Pick<Pool, 'query'>
  db: SqlDataRuntime['db']
  lease: AgentDispatchLease
  upload: ReturnType<typeof createPostgresFileUploadOperations>
  open: WebDownloadPort['open']
}) {
  const readWorkspace = createSessionWorkspaceTargetReader(options.db, 'postgres')
  function resolve(location: Parameters<WebDownloadPort['prepare']>[0], owner: string, session: string, client?: Pick<PoolClient, 'query'>) {
    return resolveWebDownloadLocation(location, {
      async bound() {
        const read = client ? createSessionWorkspaceTargetReader(options.db, 'postgres', async <Row>(statement: RawBuilder<Row>) => {
          const compiled = statement.compile(options.db)
          return (await client.query(compiled.sql, [...compiled.parameters])).rows as Row[]
        }) : readWorkspace
        const selected = await read(owner, Number(session), { lockSession: Boolean(client) })
        if (!selected) return null
        return {
          space: selected.space, workspaceId: selected.workspaceId,
          projectId: selected.kind === 'directory' ? null : selected.projectId,
          folderId: selected.kind === 'directory' ? null : selected.folderId,
          workspaceDirectoryId: selected.kind === 'directory' ? selected.directoryId : null,
        }
      },
      async folder(id) {
        const result = await (client ?? options.pool).query<{ project_id: number | null; workspace_directory_id: number | null }>(
          'SELECT project_id,workspace_directory_id FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [id, owner],
        )
        const row = result.rows[0]
        return row ? { projectId: row.project_id, workspaceDirectoryId: row.workspace_directory_id } : null
      },
    })
  }
  return createWebDownloadTool({
    open: options.open,
    extension: mime => extension(mime) || null,
    async reconcile(identity, call) {
      try {
        const previous = await options.upload.readDownloadReceipt(identity.ownerId, receipt(identity, call))
        return previous === null ? { kind: 'unknown' } : result(previous, false, call)
      } catch (error) {
        if (error instanceof CoreError && error.code === 'conflict') return failure(error.message)
        throw error
      }
    },
    async prepare(location, scope) {
      await ensureWebDownloadStagingCleanup()
      const owner = scope.identity.ownerId
      const { signal } = scope
      const resolved = await resolve(location, owner, scope.identity.sessionId)
      signal.throwIfAborted()
      if ('error' in resolved) return resolved
      const { workspaceId: _workspaceId, ...coordinates } = resolved
      const target: FileUploadInput = {
        ...coordinates, stageName: '', mindMapId: null, onConflict: 'keep_both', overwriteFileId: null,
      }
      let capacity: number | null
      try { capacity = await options.upload.getUploadCapacity(owner, target) }
      catch (error) {
        if (error instanceof CoreError && (error.code === 'not_found' || error.code === 'invalid_request')) return { error: error.message }
        throw error
      }
      return {
        capacity,
        async store(file, _scope, call) {
          const directory = await mkdtemp(path.join(tmpdir(), 'gugu-web-download-'))
          try {
            const staged = await stageFile(Readable.from(file.data, { objectMode: false }), directory, capacity, file.mimeType, signal)
            signal.throwIfAborted()
            try {
              const placed = await options.upload.store(owner, {
                ...staged, input: target, originalName: file.name, mimeType: file.mimeType,
              }, { idempotencyKey: null, undoContextId: null, clientId: null },
              { receipt: receipt({ ...scope.identity, roundId: scope.roundId }, call), signal,
                async authorize(client) {
                  const authority = createWebAgentRagRunAuthorization(client, options.lease, { enabledWebDownload: true })
                  if (!await authority.authorize(scope.identity, 'web_download', signal)) throw new DownloadLeaseLost()
                  const current = await resolve(location, owner, scope.identity.sessionId, client)
                  if (stableJson(current) !== stableJson(resolved)) throw new DownloadTargetChanged()
                },
              }) as { file: UploadFile; replayed: boolean }
              return result(placed.file, !placed.replayed, call)
            } catch (error) {
              if (signal.aborted) signal.throwIfAborted()
              if (error instanceof DownloadLeaseLost) return failure('下载运行授权已失效')
              if (error instanceof DownloadTargetChanged) return failure('会话的文件落点已变化，请重新发起下载')
              if ((error as { statusCode?: number })?.statusCode === 413) return failure('下载内容超过当前用户可用存储空间')
              if (error instanceof CoreError && ['invalid_request', 'not_found', 'conflict'].includes(error.code)) return failure(error.message)
              return { kind: 'unknown' }
            }
          } finally { await rm(directory, { recursive: true, force: true }).catch(() => undefined) }
        },
      }
    },
  })
}
