import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { FileHandle } from 'node:fs/promises'
import type { Pool, PoolClient } from 'pg'
import type { RawBuilder } from 'kysely'
import { CoreError } from '@gugu/core'
import { stableJson } from '@gugu/core/agent'
import type { RunIdentity, ToolCall } from '@gugu/core/agent'
import type { SaveUploadedFilePort } from '@gugu/core/tools'
import { createSessionWorkspaceTargetReader } from '@gugu/core/workspaces/shell-target'
import type { SqlDataRuntime } from '@gugu/core/data'
import { stageFile, type FileUploadInput, type FileUploadOperations, type FileUploadReceipt } from '../../../files/upload.js'
import { createWebAgentRagRunAuthorization } from '../../rag/authorize.js'
import type { AgentDispatchLease } from '../../run/dispatch.js'

const SAVE_METHOD = 'agent.file.save_uploaded_file' as const
const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
function receipt(identity: RunIdentity & { roundId: string }, call: ToolCall, attachId: string, target: FileUploadInput): FileUploadReceipt {
  const hash = digest([SAVE_METHOD, identity.ownerId, identity.sessionId, identity.runId, identity.roundId, call.id, attachId])
  return {
    operationId: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
    fingerprint: digest([attachId, target]), method: SAVE_METHOD,
  }
}

function knownFailure(error: unknown): string | null {
  if ((error as { statusCode?: unknown } | null)?.statusCode === 413) return '附件超过目标文件空间可用容量'
  if (error instanceof CoreError && ['invalid_request', 'not_found', 'conflict'].includes(error.code)) return error.message
  return null
}

function uploadTarget(input: Parameters<SaveUploadedFilePort['save']>[1], workspaceDirectoryId: number | null = null): FileUploadInput {
  return {
    space: input.space, projectId: input.project_id ?? null, folderId: input.folder_id ?? null,
    workspaceDirectoryId, stageName: '', mindMapId: null, onConflict: 'keep_both', overwriteFileId: null,
  }
}

/** 按 owner/当前会话解析附件，复用正式文件配额、上传事务、Undo 与写入收据。 */
export function createWebAgentSaveUploadedFilePort(options: {
  pool: Pick<Pool, 'query'>
  db: SqlDataRuntime['db']
  upload: FileUploadOperations
  downloadAttachment(ownerId: string, attachId: string): Promise<{
    fileName: string; ext: string; mimeType: string; handle: FileHandle
  }>
  lease: AgentDispatchLease
}): SaveUploadedFilePort {
  const expected = Object.freeze({ ...options.lease.identity })
  const matchesLease = (identity: RunIdentity) => identity.ownerId === expected.ownerId
    && identity.sessionId === expected.sessionId && identity.runId === expected.runId
  const authorize = createWebAgentRagRunAuthorization(options.pool, options.lease, { enabledSaveUploadedFile: true })
  async function resolveTarget(identity: RunIdentity, input: Parameters<SaveUploadedFilePort['save']>[1],
    signal: AbortSignal, client?: Pick<PoolClient, 'query'>): Promise<FileUploadInput> {
    if (input.space !== 'workspace') return uploadTarget(input)
    const read = createSessionWorkspaceTargetReader(options.db, 'postgres', async <Row>(statement: RawBuilder<Row>) => {
      const compiled = statement.compile(options.db)
      return (await (client ?? options.pool).query(compiled.sql, [...compiled.parameters])).rows as Row[]
    })
    const sessionId = Number(identity.sessionId)
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) throw new CoreError('invalid_request', '当前会话工作区不可用')
    const selected = await read(identity.ownerId, sessionId, { lockSession: Boolean(client) })
    signal.throwIfAborted()
    if (!selected) throw new CoreError('invalid_request', '当前会话没有可写入的工作区目录；请绑定工作区或选择 personal/project')
    if (selected.kind !== 'directory') throw new CoreError('invalid_request', '当前会话绑定的工作区没有可写入的文件目录；请省略目标位置参数以使用当前工作区落点')
    return uploadTarget(input, selected.directoryId)
  }

  async function latestAttachment(identity: RunIdentity, signal: AbortSignal): Promise<string | null> {
    signal.throwIfAborted()
    if (!matchesLease(identity)) return null
    const result = await options.pool.query<{ attach_id: string }>(`SELECT a.attach_id
      FROM chat_attachments a
      LEFT JOIN conversation_messages m ON m.id=a.message_id
      LEFT JOIN conversation_sessions s ON s.id=m.session_id AND s.user_id=a.user_id
      WHERE a.user_id=$1 AND (a.state='draft' OR (a.state='attached' AND s.id=$2))
      ORDER BY a.created_at DESC,a.id DESC LIMIT 1`, [expected.ownerId, Number(expected.sessionId)])
    signal.throwIfAborted()
    return result.rows[0]?.attach_id ?? null
  }

  async function saveOne(identity: RunIdentity, attachId: string, target: FileUploadInput,
    roundId: string, call: ToolCall, signal: AbortSignal): Promise<{ attach_id: string; file_id: number; name: string; size_bytes: number; space: string; folder_id: number | null; project_id: number | null; mutated: boolean } | { attach_id: string; error: string }> {
    signal.throwIfAborted()
    if (!matchesLease(identity)) return { attach_id: attachId, error: '附件保存授权已失效' }
    let opened: Awaited<ReturnType<typeof options.downloadAttachment>> | undefined
    let directory: string | undefined
    try {
      opened = await options.downloadAttachment(expected.ownerId, attachId)
      const capacity = await options.upload.getUploadCapacity(expected.ownerId, target)
      signal.throwIfAborted()
      directory = await mkdtemp(path.join(tmpdir(), 'gugu-agent-save-attachment-'))
      const originalName = path.basename(opened.fileName).replace(/[\\/\p{Cc}]/gu, '_').slice(0, 300) || 'attachment.bin'
      const staged = await stageFile(opened.handle.createReadStream({ autoClose: false }), directory, capacity, opened.mimeType, signal)
      signal.throwIfAborted()
      const stored = await options.upload.store(expected.ownerId, {
        ...staged, input: target, originalName, mimeType: opened.mimeType || null,
      }, {
        idempotencyKey: null,
        undoContextId: `agent:${expected.sessionId}:${expected.runId}`.slice(0, 128),
        clientId: null,
      }, {
        receipt: receipt({ ...expected, roundId }, call, attachId, target), signal,
        async authorize(client: Pick<PoolClient, 'query'>) {
          const current = createWebAgentRagRunAuthorization(client, options.lease, { enabledSaveUploadedFile: true })
          if (!await current.authorize(identity, 'save_uploaded_file', signal)) throw new Error('附件保存授权已失效')
          if (target.space === 'workspace') {
            const currentTarget = await resolveTarget(identity, { source: 'attach_id', attach_id: attachId,
              space: 'workspace', ...(target.folderId === null ? {} : { folder_id: target.folderId }) }, signal, client)
            if (currentTarget.workspaceDirectoryId !== target.workspaceDirectoryId) throw new Error('附件保存授权已失效')
          }
        },
      }) as { file?: Record<string, unknown>; replayed?: boolean }
      signal.throwIfAborted()
      const file = stored?.file
      if (!file || !Number.isSafeInteger(file.id) || typeof file.displayName !== 'string'
        || typeof file.ext !== 'string' || !Number.isSafeInteger(file.sizeBytes))
        return { attach_id: attachId, error: '文件保存返回无效结果' }
      return { attach_id: attachId, file_id: Number(file.id), name: `${file.displayName}${file.ext ? `.${file.ext}` : ''}`,
        size_bytes: Number(file.sizeBytes), space: target.space, folder_id: target.folderId, project_id: target.projectId,
        mutated: stored.replayed !== true }
    } catch (error) {
      signal.throwIfAborted()
      return { attach_id: attachId, error: knownFailure(error) ?? '附件保存失败，请确认附件仍可用及目标空间权限' }
    } finally {
      await opened?.handle.close().catch(() => undefined)
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  return {
    async save(identity, input, roundId, call, signal) {
      signal.throwIfAborted()
      if (!matchesLease(identity)) return { kind: 'failed', error: '附件保存授权已失效' }
      let target: FileUploadInput
      try { target = await resolveTarget(identity, input, signal) }
      catch (error) { signal.throwIfAborted(); return { kind: 'failed', error: knownFailure(error) ?? '附件保存目标不可用' } }
      const ids = input.source === 'latest'
        ? [await latestAttachment(identity, signal)].filter((id): id is string => Boolean(id))
        : input.source === 'attach_id' ? [input.attach_id ?? ''] : [...(input.attach_ids ?? [])]
      if (input.source === 'latest' && ids.length === 0) return { kind: 'failed', error: '当前对话中没有可保存的近期附件' }
      if (ids.some(id => !/^[A-Za-z0-9_-]{1,128}$/u.test(id))) return { kind: 'failed', error: '附件 ID 无效' }
      const results = []
      for (const id of ids) {
        signal.throwIfAborted()
        results.push(await saveOne(identity, id, target, roundId, call, signal))
      }
      const saved = results.filter((result): result is Extract<typeof result, { file_id: number }> => 'file_id' in result)
      const failed = results.filter((result): result is Extract<typeof result, { error: string }> => 'error' in result)
      if (input.source === 'attach_id' || input.source === 'latest') {
        const single = results[0]
        if (single && 'error' in single) return { kind: 'failed', error: single.error }
        if (single && 'file_id' in single) return { kind: 'saved', mutated: single.mutated, value: {
          file_id: single.file_id, name: single.name, size: single.size_bytes, space: single.space,
          ...(single.project_id ? { project_id: single.project_id } : {}), ...(single.folder_id ? { folder_id: single.folder_id } : {}),
        } }
        return { kind: 'failed', error: '附件不存在或已过期' }
      }
      const savedItems = saved.map(({ mutated: _mutated, ...item }) => item)
      return { kind: 'saved', mutated: saved.some(item => item.mutated), value: {
        success: true, saved_count: saved.length, failed_count: failed.length, saved: savedItems, failed,
      } }
    },
  }
}
