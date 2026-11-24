import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { z } from 'zod'
import { CoreError } from '@gugu/core'
import { stableJson, type Json, type RunIdentity, type ToolResult } from '@gugu/core/agent'
import type { ToolDefinition, ToolScope } from '@gugu/core/tools'
import { createLocalFileTree, UnsafeLocalPathError } from '@gugu/fs/node'
import type { Pool } from 'pg'
import { sandboxTarget } from '../../../terminals/sandbox/mounts.js'
import { createWorkspaceFileReads, resolveFileDirectoryRoot, type FileDirectory } from '../../../workspaces/files.js'
import type { TrashEntry } from '../../../files/trash/disk.js'
import type { createWebAgentToolConfirmation } from '../confirm.js'

type Confirmation = ReturnType<typeof createWebAgentToolConfirmation>
type Action = 'delete_item' | 'restore_file' | 'restore_folder' | 'permanent_delete'
const trashPrefix = '/trash/'
const maxBatchSize = 50
const trashPath = /^\/trash\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u
const descriptions = {
  delete_item: '按沙盒映射路径将一个文件或文件夹移入回收站，需确认，可在 30 天内恢复。使用 /workspace、/personal、/project 下的路径，或相对于当前工作区的路径。成功返回回收站路径。',
  restore_file: '按 list_trash 返回的 /trash 路径恢复文件到原来的沙盒位置，需确认。',
  restore_folder: '按 list_trash 返回的 /trash 路径恢复文件夹到原来的沙盒位置，需确认。',
  permanent_delete: '永久删除回收项：path 删除单项，paths 批量删除，all=true 清空。使用 list_trash 返回的路径，操作需确认且不可恢复。',
} satisfies Record<Action, string>
const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
const failure = (error: string): ToolResult => ({
  kind: 'completed', successful: false, mutated: false, executed: false, value: { error },
})
const success = (value: unknown, mutated: boolean): ToolResult => ({
  kind: 'completed', successful: true, mutated, executed: true, value,
})

export function createAgentDiskTrashTools(options: {
  pool: Pick<Pool, 'query'>
  storageRoot: string
  authorize(identity: RunIdentity, signal: AbortSignal): Promise<boolean>
  currentDirectory(identity: RunIdentity): Promise<string | null>
  confirmations: Record<Action, Confirmation>
  claim(confirmation: Confirmation, reference: Parameters<Confirmation['claim']>[1], signal: AbortSignal): Promise<boolean>
}): ToolDefinition[] {
  const files = createWorkspaceFileReads(options.pool, options.storageRoot)

  async function resolveTarget(identity: RunIdentity, path: string) {
    if (path.split('/').includes('..')) throw new CoreError('invalid_request', '文件路径不得越界')
    const owner = identity.ownerId
    const cwd = path.startsWith('/') ? '/' : await options.currentDirectory(identity)
    if (!cwd) throw new CoreError('invalid_request', '当前会话没有可用工作区，请使用绝对路径')
    const absolute = posix.resolve(cwd, path)
    const [, space, name] = absolute.split('/')
    let directory: FileDirectory
    if (space === 'personal') directory = 'personal'
    else if (space === 'workspace' && name) {
      const { rows: [row] } = await options.pool.query<{ id: number }>(`SELECT id FROM workspace_directories
        WHERE user_id=$1 AND directory_name=$2 AND deleted_at IS NULL`, [owner, name])
      if (!row) throw new CoreError('not_found', '工作区不存在')
      directory = Number(row.id)
    } else {
      const project = /^\/project\/(?:\d{4}\/\d{2}\/)?[^/]+ #(\d+)\//u.exec(absolute)
      const projectId = Number(project?.[1])
      if (!Number.isSafeInteger(projectId) || projectId < 1) throw new CoreError('invalid_request', '请选择个人文件、工作区或项目内的文件')
      directory = { projectId }
    }
    const root = await resolveFileDirectoryRoot(options.pool, owner, directory)
    const target = sandboxTarget(root)
    if (!absolute.startsWith(target + '/')) throw new CoreError('invalid_request', '文件路径不在当前账号的目标目录内')
    const relative = absolute.slice(target.length + 1)
    return { directory, relative, root, source: root + '/' + relative, absolute }
  }

  async function originalPath(owner: string, entry: TrashEntry) {
    const root = await resolveFileDirectoryRoot(options.pool, owner, entry.directory)
    return sandboxTarget(root) + '/' + entry.relativePath
  }

  function publicEntry(entry: TrashEntry, original: string | null) {
    return { path: trashPrefix + entry.id, trash_id: entry.id, original_path: original, name: entry.name,
      kind: entry.kind, deleted_at: entry.deletedAt }
  }

  function mutation(action: Action): ToolDefinition {
    const single = z.object({ path: z.string().min(1).max(4096).refine(path =>
      action === 'delete_item' ? !/[\p{Cc}\\]/u.test(path) && !path.endsWith('/') : trashPath.test(path)) }).strict()
    const deletion = single.extend({ kind: z.enum(['file', 'folder']) })
    const parse = action === 'delete_item' ? deletion : action === 'permanent_delete' ? z.union([
      single,
      z.object({ paths: z.array(z.string().regex(trashPath)).min(1).max(maxBatchSize)
        .refine(paths => new Set(paths).size === paths.length) }).strict(),
      z.object({ all: z.literal(true) }).strict(),
    ]) : single
    const pathSchema = { type: 'string', minLength: 1, maxLength: 4096 }
    const parameters: Json = action === 'permanent_delete' ? {
      type: 'object', additionalProperties: false,
      properties: { path: pathSchema, paths: { type: 'array', items: pathSchema, minItems: 1, maxItems: maxBatchSize, uniqueItems: true },
        all: { type: 'boolean', const: true } },
      oneOf: [{ required: ['path'] }, { required: ['paths'] }, { required: ['all'] }],
    } : { type: 'object', additionalProperties: false, required: action === 'delete_item' ? ['path', 'kind'] : ['path'], properties: { path: pathSchema, ...(action === 'delete_item' ? { kind: { type: 'string', enum: ['file', 'folder'] } } : {}) } }
    return {
      definition: { name: action, schema: { type: 'function', function: { name: action, description: descriptions[action],
        parameters } } },
      effect: 'write', destructive: true, requiresInteraction: true, confirmationReplay: true,
      ...(action === 'permanent_delete' ? { strictArrayFields: ['paths'] } : {}),
      validate: input => parse.safeParse(input),
      async execute(input, scope, call) {
        const args = parse.parse(input)
        const path = 'path' in args ? args.path : ''
        const { signal, identity: { ownerId } } = scope
        if (!await options.authorize(scope.identity, signal)) return failure('当前会话没有回收站权限')
        const confirmation = options.confirmations[action]
        let applying = false
        try {
          const plan = await prepare()
          if (!plan) return scope.resolution
            ? failure('回收站已变化，请重新查看')
            : success({ deleted_count: 0, note: '回收站是空的' }, false)
          const confirmationSnapshot = {
            targetRefs: { disk_path: [digest(plan.path)] },
            targetsDigest: digest(plan.path), versionsDigest: digest(plan.version), displaySummary: plan.summary,
          }
          const argsDigest = digest(args)
          if (!scope.resolution) {
            const prepared = await confirmation.gate.prepare(call, scope, argsDigest, confirmationSnapshot)
            return prepared.ok ? { kind: 'waiting', interaction: prepared.value } : failure('无法申请文件操作确认')
          }
          const approved = await confirmation.gate.verify(call, scope, argsDigest, confirmationSnapshot)
          if (!approved.ok || !await options.claim(confirmation, approved.value, signal))
            return failure('文件操作确认无效、已过期或目标已变化')
          if (!await options.authorize(scope.identity, signal)
            || digest((await prepare())?.version ?? null) !== digest(plan.version))
            return failure('文件操作权限或目标已变化')
          signal.throwIfAborted()
          applying = true
          return success(await plan.apply(), true)
        } catch (error) {
          signal.throwIfAborted()
          if (error instanceof CoreError && error.code !== 'storage_error') return failure(error.message)
          if (error instanceof UnsafeLocalPathError) return failure('沙盒文件路径无效')
          if (applying) return { kind: 'unknown' }
          throw error
        }

        async function prepare() {
          if (action === 'permanent_delete') {
            const all = 'all' in args
            const paths = 'paths' in args ? args.paths : [path]
            const entries: TrashEntry[] = all ? await files.listDiskTrash(ownerId) : []
            for (const item of all ? [] : paths) {
              signal.throwIfAborted()
              const entry = await files.getDiskTrash(ownerId, trashPath.exec(item)![1]!)
              if (!entry) throw new CoreError('not_found', '回收项不存在')
              entries.push(entry)
            }
            if (!entries.length) return null
            entries.sort((left, right) => left.id.localeCompare(right.id))
            const fileCount = entries.filter(entry => entry.kind === 'file').length
            const description = entries.length === 1 && !all ? `${entries[0]!.name}（${paths[0]}）`
              : `${fileCount} 个文件和 ${entries.length - fileCount} 个文件夹`
            return {
              path: all ? trashPrefix : paths.length === 1 ? paths[0]! : paths.slice().sort(),
              version: entries, summary: `${all ? '永久清空回收站' : '永久删除回收项'}（不可恢复）：${description}`,
              apply: async () => {
                let deleted = 0
                for (const entry of entries) {
                  signal.throwIfAborted()
                  try { await files.purgeDiskTrash(ownerId, entry.id) }
                  catch (error) {
                    if (deleted === 0) throw error
                    throw new CoreError('storage_error', '部分回收项已处理，需重新查看回收站')
                  }
                  deleted++
                }
                return { ...(paths.length === 1 && !all ? { path: paths[0] } : {}), permanently_deleted: true, deleted_count: deleted }
              },
            }
          }
          if (action === 'delete_item') {
            const target = await resolveTarget(scope.identity, path)
            const { kind } = deletion.parse(input)
            const tree = createLocalFileTree(options.storageRoot, target.root)
            const opened = await (kind === 'folder' ? tree.openDirectory(target.relative) : tree.open(target.relative))
            if (!opened) throw new CoreError('not_found', '文件不存在或目标不是普通文件')
            let version
            try {
              const stat = await opened.handle.stat({ bigint: true })
              version = [target.source, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)
            } finally { await opened.handle.close() }
            return { path: target.absolute, version, summary: `将${kind === 'folder' ? '文件夹及其所有子项' : '文件'}移入回收站（30 天内可恢复）：${target.absolute}`,
              apply: async () => publicEntry(await files.trashPath(ownerId, target.directory, target.relative, target.root), target.absolute) }
          }
          const id = trashPath.exec(path)![1]!
          const entry = await files.getDiskTrash(ownerId, id)
          if (!entry) throw new CoreError('not_found', '回收项不存在')
          if (entry.kind !== (action === 'restore_file' ? 'file' : 'directory'))
            throw new CoreError('invalid_request', '回收项类型与工具不符')
          const root = await resolveFileDirectoryRoot(options.pool, ownerId, entry.directory)
          const original = sandboxTarget(root) + '/' + entry.relativePath
          return { path, version: [entry, root], summary: `将回收项恢复到：${original}`,
            apply: async () => { await files.restoreDiskTrash(ownerId, id, root); return { ...publicEntry(entry, original), restored: true } } }
        }
      },
    }
  }

  const pagination = z.object({ offset: z.number().int().min(0).max(100_000).default(0) }).strict()
  const list: ToolDefinition = {
    definition: { name: 'list_trash', schema: { type: 'function', function: {
      name: 'list_trash', description: '列出当前账号磁盘回收站，每页最多 50 项。恢复或永久删除使用返回的 /trash 路径。',
      parameters: { type: 'object', additionalProperties: false, properties: { offset: { type: 'integer', minimum: 0, maximum: 100_000 } } },
    } } },
    effect: 'read',
    validate: input => pagination.safeParse(input),
    async execute(input, scope) {
      if (!await options.authorize(scope.identity, scope.signal)) return failure('当前会话没有回收站权限')
      scope.signal.throwIfAborted()
      const { offset } = pagination.parse(input)
      const { ownerId } = scope.identity
      const entries = await files.listDiskTrash(ownerId)
      scope.signal.throwIfAborted()
      const items = await Promise.all(entries.slice(offset, offset + 50).map(async entry => {
        let original: string | null
        try { original = await originalPath(ownerId, entry) }
        catch (error) {
          if (!(error instanceof CoreError) || error.code !== 'not_found') throw error
          original = null
        }
        return publicEntry(entry, original)
      }))
      scope.signal.throwIfAborted()
      return success({ items, next_offset: offset + items.length < entries.length ? offset + items.length : null }, false)
    },
  }
  return [list, ...(['delete_item', 'restore_file', 'restore_folder', 'permanent_delete'] as const).map(mutation)]
}
