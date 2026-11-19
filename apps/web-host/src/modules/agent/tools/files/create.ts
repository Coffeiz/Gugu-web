import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { Pool, PoolClient } from 'pg'
import type { RawBuilder } from 'kysely'
import { CoreError } from '@gugu/core'
import { stableJson } from '@gugu/core/agent'
import type { RunIdentity, ToolCall } from '@gugu/core/agent'
import type { FileCreatePort } from '@gugu/core/tools'
import { createSessionWorkspaceTargetReader } from '@gugu/core/workspaces/shell-target'
import type { SqlDataRuntime } from '@gugu/core/data'
import { stageFile, type FileUploadInput, type FileUploadOperations, type FileUploadReceipt } from '../../../files/upload.js'
import { createWebAgentRagRunAuthorization } from '../../rag/authorize.js'
import type { AgentDispatchLease } from '../../run/dispatch.js'

const CREATE_METHOD = 'agent.file.create' as const
const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
function receipt(identity: RunIdentity & { roundId: string }, call: ToolCall): FileUploadReceipt {
  const hash = digest(['agent.file.create', identity.ownerId, identity.sessionId, identity.runId, identity.roundId, call.id])
  return {
    operationId: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
    fingerprint: digest(call.input),
    method: CREATE_METHOD,
  }
}

function uploadInput(input: Parameters<FileCreatePort['create']>[1]): FileUploadInput {
  return {
    space: input.space,
    projectId: input.project_id ?? null,
    folderId: input.folder_id ?? null,
    workspaceDirectoryId: input.workspace_directory_id ?? null,
    stageName: '', mindMapId: null, onConflict: 'keep_both', overwriteFileId: null,
  }
}

function knownFailure(error: unknown): string | null {
  if ((error as { statusCode?: unknown } | null)?.statusCode === 413) return '内容超过当前用户可用存储空间'
  if (error instanceof CoreError && ['invalid_request', 'not_found', 'conflict'].includes(error.code)) return error.message
  return null
}

/** 用正式文件上传事务创建文本文件，校验配额、lease、重复调用收据与 owner 归属。 */
export function createWebAgentFileCreatePort(options: {
  pool: Pick<Pool, 'query'>
  db?: SqlDataRuntime['db']
  upload: FileUploadOperations
  lease: AgentDispatchLease
}): FileCreatePort {
  const expected = Object.freeze({ ...options.lease.identity })
  const matchesLease = (identity: RunIdentity) => identity.ownerId === expected.ownerId
    && identity.sessionId === expected.sessionId && identity.runId === expected.runId
  async function workspaceDirectory(identity: RunIdentity, signal: AbortSignal, client?: Pick<PoolClient, 'query'>) {
    if (!options.db || !matchesLease(identity)) return null
    const read = createSessionWorkspaceTargetReader(options.db, 'postgres', async <Row>(statement: RawBuilder<Row>) => {
      const compiled = statement.compile(options.db!)
      return (await (client ?? options.pool).query(compiled.sql, [...compiled.parameters])).rows as Row[]
    })
    const sessionId = Number(expected.sessionId)
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) return null
    const target = await read(expected.ownerId, sessionId, { lockSession: Boolean(client) })
    signal.throwIfAborted()
    return target?.kind === 'directory' ? target.directoryId : null
  }
  return {
    resolveWorkspaceDirectory: workspaceDirectory,
    async create(identity, input, roundId, call, signal) {
      signal.throwIfAborted()
      if (!matchesLease(identity)) return { kind: 'failed', error: '文件创建授权已失效' }
      if (input.space === 'workspace' && (!input.workspace_directory_id
        || await workspaceDirectory(identity, signal) !== input.workspace_directory_id))
        return { kind: 'failed', error: '当前会话工作区授权已失效' }
      const target = uploadInput(input)
      let capacity: number | null
      try { capacity = await options.upload.getUploadCapacity(expected.ownerId, target) }
      catch (error) { return { kind: 'failed', error: knownFailure(error) ?? '无法读取文件空间配额' } }
      signal.throwIfAborted()
      const directory = await mkdtemp(path.join(tmpdir(), 'gugu-agent-file-create-'))
      let storeStarted = false
      try {
        const staged = await stageFile(Readable.from(Buffer.from(input.content, 'utf8'), { objectMode: false }), directory, capacity, 'text/plain', signal)
        signal.throwIfAborted()
        storeStarted = true
        const placed = await options.upload.store(expected.ownerId, {
          ...staged, input: target, originalName: input.filename, mimeType: 'text/plain',
        }, {
          idempotencyKey: null,
          undoContextId: `agent:${expected.sessionId}:${expected.runId}`.slice(0, 128),
          clientId: null,
        }, {
          receipt: receipt({ ...expected, roundId }, call),
          signal,
          async authorize(client: Pick<PoolClient, 'query'>) {
            const authority = createWebAgentRagRunAuthorization(client, options.lease, { enabledFileCreate: true })
            if (!await authority.authorize(identity, 'create_file', signal)) throw new Error('文件创建授权已失效')
            if (target.space === 'workspace' && await workspaceDirectory(identity, signal, client) !== target.workspaceDirectoryId)
              throw new Error('文件创建授权已失效')
          },
        }) as { file: unknown; replayed: boolean }
        signal.throwIfAborted()
        if (!placed.file || typeof placed.file !== 'object' || Array.isArray(placed.file)) return { kind: 'unknown' }
        const file = placed.file as Record<string, unknown>
        if (!Number.isSafeInteger(file.id) || typeof file.displayName !== 'string' || typeof file.ext !== 'string' || !Number.isSafeInteger(file.sizeBytes))
          return { kind: 'unknown' }
        return { kind: 'created', file_id: Number(file.id), name: `${file.displayName}${file.ext ? `.${file.ext}` : ''}`,
          size_bytes: Number(file.sizeBytes), mutated: !placed.replayed }
      } catch (error) {
        signal.throwIfAborted()
        const known = knownFailure(error)
        return known ? { kind: 'failed', error: known }
          : storeStarted ? { kind: 'unknown' } : { kind: 'failed', error: '文件创建失败' }
      } finally {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined)
      }
    },
  }
}
