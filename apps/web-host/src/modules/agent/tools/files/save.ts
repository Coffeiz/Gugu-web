import { readSessionToolAttachments } from './session-attachments.js'
import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { posix } from 'node:path'
import type { Pool } from 'pg'
import { CoreError, dataContext } from '@gugu/core'
import { stableJson } from '@gugu/core/agent'
import type { RunIdentity, ToolCall } from '@gugu/core/agent'
import { agentDownloadsLimit, type SaveAttachmentPort } from '@gugu/core/tools'
import { createSessionWorkspaceTargetReader } from '@gugu/core/workspaces/shell-target'
import type { SqlDataRuntime } from '@gugu/core/data'
import { createLocalFileTree } from '@gugu/fs/node'
import { createWorkspaceFileReads, resolveFileDirectoryRoot, type FileDirectory } from '../../../workspaces/files.js'
import { createWebAgentRagRunAuthorization } from '../../rag/authorize.js'
import type { AgentDispatchLease } from '../../run/dispatch.js'

const method = 'agent.file.save_path_attachment'
const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
type SaveInput = Parameters<SaveAttachmentPort['save']>[1]

function saveName(original: string, suffix: string) {
  const clean = Array.from(posix.basename(original).replace(/[\\/\p{Cc}<>:"|?*]/gu, '_').trim().replace(/^\.+/u, '')).slice(0, 48).join('') || '附件'
  const extension = posix.extname(clean)
  return clean.slice(0, clean.length - extension.length) + '-' + suffix + extension
}

/** 附件归属、目录授权和幂等收据沿用 Host 的可信运行身份。 */
export function createWebAgentSaveAttachmentPort(options: {
  pool: Pick<Pool, 'query'>
  core: SqlDataRuntime
  storageRoot: string
  downloadAttachment(ownerId: string, attachId: string): Promise<{ fileName: string; ext: string; mimeType: string; handle: FileHandle }>
  lease: AgentDispatchLease
  authorizeOwner?: () => Promise<boolean>
}): SaveAttachmentPort {
  const expected = options.lease.identity
  const authorize = options.authorizeOwner ? undefined : createWebAgentRagRunAuthorization(options.pool, options.lease, { enabledSaveAttachment: true })
  const readWorkspace = createSessionWorkspaceTargetReader(options.core.db, 'postgres')
  const files = createWorkspaceFileReads(options.pool, options.storageRoot)

  async function resolveTarget(owner: string, session: number, input: SaveInput) {
    let directory: FileDirectory = 'personal'
    if (input.space === 'project') {
      if (!input.project_id) throw new CoreError('invalid_request', '未指定项目')
      directory = { projectId: input.project_id }
    } else if (input.space === 'workspace') {
      const target = await readWorkspace(owner, session)
      if (target?.kind !== 'directory') throw new CoreError('invalid_request', '当前会话没有可写入的工作区目录')
      directory = target.directoryId
    }
    const root = await resolveFileDirectoryRoot(options.pool, owner, directory)
    const useDownloads = input.space === 'personal' && input.folder_path === undefined
    const folder = input.folder_path ?? (useDownloads ? 'download' : '')
    const reference = folder && !useDownloads ? await files.reference(owner, directory, folder, undefined, 'folder') : null
    return { directory, root, folder, folderReference: reference?.id ?? null }
  }

  return {
    async save(identity, input, roundId, call: ToolCall, signal) {
      const owner = identity.ownerId, session = Number(identity.sessionId)
      const allowed = async () => {
        signal.throwIfAborted()
        return identity.ownerId === expected.ownerId && identity.sessionId === expected.sessionId
          && identity.runId === expected.runId && (options.authorizeOwner
            ? await options.authorizeOwner() : await authorize?.authorize(identity, 'save_attachment', signal) === true)
      }
      if (!await allowed()) return { kind: 'failed', error: '附件保存授权已失效' }
      let target: Awaited<ReturnType<typeof resolveTarget>>
      try { target = await resolveTarget(owner, session, input) }
      catch (error) {
        signal.throwIfAborted()
        if (error instanceof CoreError && ['invalid_request', 'not_found', 'conflict'].includes(error.code))
          return { kind: 'failed', error: error.message }
        throw error
      }
      const ids = input.source === 'latest' ? (await readSessionToolAttachments(options.pool, identity, null)).map(row => row.attach_id)
        : input.source === 'attach_id' ? [input.attach_id ?? ''] : [...(input.attach_ids ?? [])]
      if (!ids.length) return { kind: 'failed', error: '当前对话没有可保存的附件' }
      const owned = new Set((await readSessionToolAttachments(options.pool, identity, ids, input.source !== 'latest')).map(row => row.attach_id))
      const saved: Record<string, unknown>[] = []
      const failed: Array<{ attach_id: string; error: string }> = []
      let mutated = false
      for (const id of ids) {
        signal.throwIfAborted()
        if (!owned.has(id)) { failed.push({ attach_id: id, error: '附件不存在或已过期' }); continue }
        const key = digest([method, owner, identity.sessionId, identity.runId, roundId, call.id, id])
        const operation = [key.slice(0, 8), key.slice(8, 12), '5' + key.slice(13, 16), '8' + key.slice(17, 20), key.slice(20, 32)].join('-')
        const receipt = await options.core.operationWithTransaction(dataContext(owner), operation, method, { id, target }, async () => {
          if (!await allowed()) throw new CoreError('conflict', '附件保存授权已失效')
          const attachment = await options.downloadAttachment(owner, id)
          try {
            const stats = await attachment.handle.stat()
            if (!stats.isFile() || stats.size > agentDownloadsLimit)
              throw new CoreError('invalid_request', '附件超过 64 MiB 或不可读取')
            const filename = saveName(attachment.fileName, key.slice(0, 16))
            const relativePath = [target.folder, filename].filter(Boolean).join('/')
            const current = await resolveTarget(owner, session, input)
            if (stableJson(current) !== stableJson(target)) throw new CoreError('conflict', '保存目录已变化')
            const tree = createLocalFileTree(options.storageRoot, target.root)
            const useDownloads = input.space === 'personal' && input.folder_path === undefined
            const directory = useDownloads ? createLocalFileTree(options.storageRoot, `${target.root}/${target.folder}`) : tree
            if ((!target.folder || useDownloads) && !await directory.ensureRoot())
              throw new CoreError('not_found', '保存目录不可用')
            async function* data() {
              let size = 0
              for await (const chunk of attachment.handle.createReadStream({ autoClose: false, start: 0 })) {
                signal.throwIfAborted()
                size += chunk.byteLength
                if (size > stats.size) throw new CoreError('conflict', '附件内容已变化')
                yield chunk as Uint8Array
              }
              if (size !== stats.size || !await allowed() || stableJson(await resolveTarget(owner, session, input)) !== stableJson(target))
                throw new CoreError('conflict', '附件或目录授权已变化')
            }
            try { await tree.upload(relativePath, data(), signal) }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
              // 文件已发布但收据未提交时，只认同一目标上内容完全相同的文件。
              const prior = await tree.open(relativePath)
              if (!prior) throw error
              try {
                if (prior.size !== stats.size) throw new CoreError('conflict', '保存路径已被占用')
                const hash = async (handle: FileHandle) => {
                  const digest = createHash('sha256')
                  for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
                    signal.throwIfAborted()
                    digest.update(chunk)
                  }
                  return digest.digest('hex')
                }
                if (await hash(prior.handle) !== await hash(attachment.handle))
                  throw new CoreError('conflict', '保存路径已被占用')
              } finally { await prior.handle.close() }
            }
            const file = await files.reference(owner, target.directory, relativePath)
            return { attach_id: id, name: filename, path: file.location.value, size_bytes: stats.size,
              space: input.space, link: 'gugu://open-object/file/' + file.location.value }
          } finally { await attachment.handle.close() }
        }, { signal }).catch(error => {
          signal.throwIfAborted()
          if (!(error instanceof CoreError) || !['invalid_request', 'not_found', 'conflict'].includes(error.code)) throw error
          failed.push({ attach_id: id, error: error.message })
          return null
        })
        if (receipt) {
          saved.push(receipt.result as Record<string, unknown>)
          mutated ||= !receipt.replayed
        }
      }
      if (input.source !== 'attach_ids') return saved[0]
        ? { kind: 'saved', mutated, value: saved[0] }
        : { kind: 'failed', error: failed[0]?.error ?? '附件不存在或已过期' }
      return { kind: 'saved', mutated, value: { success: true, saved_count: saved.length, failed_count: failed.length, saved, failed } }
    },
  }
}
