import { isAbsolute } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import type { SqlDataRuntime } from '#core-source/data/runtime.js'
import type { RunIdentity, ToolCall, ToolResult } from '#core-source/agent/models.js'
import type { ToolDefinition, ToolScope } from '#core-source/agent/tools/contracts.js'
import type { createOwnerToolRegistry } from '#core-source/agent/tools/owner.js'
import type { desktopTrashTarget } from '#core-source/runtime/desktop-shell-trash.js'
import { readDesktopTurnReferences, workspaceFileReferenceId } from '#core-source/agent/sessions/desktop-references.js'
import { createDesktopShellTool, desktopHostAuthorization } from '#core-source/runtime/desktop-shell.js'
import { createSqliteToolConfirmation } from '#core-source/agent/interactions/sqlite-confirmation.js'

export async function createDesktopFileTools(options: {
  db: SqlDataRuntime['db']
  interactive: boolean
  workspaceDirectoryId?: string
  authorize: (identity: RunIdentity) => Promise<boolean>
  authorizeWrite: Parameters<typeof createSqliteToolConfirmation>[1]
  hostRequest: (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
  digest: (value: unknown) => string
  readDesktopShellPreferences: () => Promise<{ automaticMode: boolean; shellEnabled: boolean; dangerousEnabled: boolean }>
  resolveReferencedFile: (id: string, signal?: AbortSignal) => Promise<{ path: string } | null>
  moveShellTargetToTrash: (target: Awaited<ReturnType<typeof desktopTrashTarget>>, cwd: string, workspace: string | undefined, signal: AbortSignal) => Promise<unknown>
}) {
  const { db, interactive, authorize, authorizeWrite, hostRequest, digest,
    readDesktopShellPreferences, resolveReferencedFile, moveShellTargetToTrash } = options
  const shellConfirmation = createSqliteToolConfirmation(db, authorizeWrite, 'shell')
  const deleteItemConfirmation = createSqliteToolConfirmation(db, authorizeWrite, 'delete_item')
  function isLibraryItemInput(input: unknown): input is { kind: 'file' | 'folder'; path: string } {
    if (!input || typeof input !== 'object' || Object.keys(input).length !== 2) return false
    const { kind, path } = input as Record<string, unknown>
    return (kind === 'file' || kind === 'folder') && typeof path === 'string'
      && path.length <= 4096 && isAbsolute(path) && !/[\p{Cc}]/u.test(path)
  }
  const deleteItem: ToolDefinition = {
    definition: { name: 'delete_item', schema: { type: 'function', function: {
      name: 'delete_item', description: '将文件库中的文件或文件夹移入系统废纸篓，文件夹包含所有子项。使用搜索结果的本机绝对路径，执行前需确认。',
      parameters: { type: 'object', additionalProperties: false, required: ['kind', 'path'],
        properties: { kind: { enum: ['file', 'folder'], type: 'string' }, path: { type: 'string' } } },
    } } },
    effect: 'write', destructive: true, requiresInteraction: true, confirmationReplay: true,
    validate(input) { return isLibraryItemInput(input) ? { success: true, data: input } : { success: false } },
    async execute(input, scope, call) {
      const fail = (error: string) => ({ kind: 'completed' as const, successful: false, mutated: false, value: { error } })
      if (!isLibraryItemInput(input) || !await authorizeWrite(db, scope.identity, scope.signal)) return fail('当前会话无权移入废纸篓')
      const target = await hostRequest('agent.files.deleteItem', input, scope.signal)
      if (typeof target !== 'string') return fail('找不到类型匹配的文件库目标')
      const snapshot = { targetsDigest: digest(input), versionsDigest: digest(target), targetIds: {} }
      const argsDigest = digest(input)
      if (!scope.resolution) {
        const prepared = await deleteItemConfirmation.gate.prepare(call, scope, argsDigest, snapshot)
        return prepared.ok ? { kind: 'waiting', interaction: prepared.value } : fail('无法申请废纸篓操作确认')
      }
      const confirmed = await deleteItemConfirmation.gate.verify(call, scope, argsDigest, snapshot)
      if (!confirmed.ok || !await db.transaction().execute(tx => deleteItemConfirmation.claim(tx, confirmed.value, scope.signal)))
        return fail('废纸篓确认已失效或目标已变化')
      scope.signal.throwIfAborted()
      const moved = await hostRequest('agent.files.deleteItem', { ...input, expected: target }, scope.signal)
      return moved === true ? { kind: 'completed', successful: true, mutated: true, value: { path: input.path, trashed: true } }
        : fail('废纸篓目标已移动或替换')
    },
  }
  const presentConfirmation = createSqliteToolConfirmation(db, authorizeWrite, 'open_item')
  const sendItemConfirmation = createSqliteToolConfirmation(db, authorizeWrite, 'send_item')
  const viewImageConfirmation = createSqliteToolConfirmation(db, authorizeWrite, 'view_image')
  const readHostAccess = async (scope: ToolScope) => {
    if (!interactive || !await authorizeWrite(db, scope.identity, scope.signal)) return null
    return readDesktopShellPreferences()
  }
  function isHostFilePath(path: string) {
    return isAbsolute(path) && !/^\/(personal|project|workspace)\//u.test(path)
  }
  async function authorizeHostFile(path: string, selector: unknown,
    scope: ToolScope,
    call: ToolCall,
    confirmation: typeof presentConfirmation): Promise<
    { target: { path: string; identity: string } } | { error: string }
    | Extract<ToolResult, { kind: 'waiting' }>
  > {
    const { identity, signal } = scope
    const access = await readHostAccess(scope)
    const grant = access && desktopHostAuthorization(access, identity, digest)
    if (!grant) return { error: '当前会话未启用宿主机文件访问' } as const
    if (/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(path)) return { error: '本机文件路径无效' } as const
    const actual = await realpath(path).catch(() => null)
    const info = actual && await stat(actual, { bigint: true }).catch(() => null)
    if (!actual || !info || !info.isFile()) return { error: '本机文件不存在或不可访问' } as const
    const target = { path: actual, identity: [info.dev, info.ino, info.birthtimeNs].join('.') }
    const snapshot = { targetsDigest: digest(target), versionsDigest: grant.version, targetIds: {} }
    const argsDigest = digest(selector)
    if (!scope.resolution && !grant.permits()) {
      const prepared = await confirmation.gate.prepare(call, scope, argsDigest, snapshot)
      return prepared.ok ? { kind: 'waiting', interaction: prepared.value } as const : { error: '无法申请宿主机文件访问授权' } as const
    }
    if (digest(access) !== digest(await readHostAccess(scope))) return { error: '宿主机文件权限已变化' } as const
    if (scope.resolution) {
      const confirmed = await confirmation.gate.verify(call, scope, argsDigest, snapshot)
      if (!confirmed.ok || !await db.transaction().execute(tx => confirmation.claim(tx, confirmed.value, signal)))
        return { error: '宿主机文件确认无效或已过期' } as const
      grant.approve()
    } else if (!grant.permits()) return { error: '宿主机文件授权已过期' } as const
    return { target } as const
  }
  const readWorkspace = options.workspaceDirectoryId === undefined ? undefined : async () => {
    const root = await hostRequest('agent.files.workspaceRoot', { directoryId: options.workspaceDirectoryId }, AbortSignal.timeout(5_000))
    return root && typeof root === 'object' && 'path' in root && typeof root.path === 'string' && isAbsolute(root.path)
      && 'identity' in root && typeof root.identity === 'string' ? { path: root.path, identity: root.identity } : null
  }
  const shell = interactive ? await createDesktopShellTool(db, shellConfirmation, digest, readHostAccess, readWorkspace, undefined, moveShellTargetToTrash) : undefined
  const presentFile: NonNullable<Parameters<typeof createOwnerToolRegistry>[0]['presentFile']> = {
    requiresHostConfirmation: true,
    async resolve(identity, selector, signal, { scope, call, batch }) {
      signal.throwIfAborted()
      if (!await authorize(identity)) return { error: '当前文件预览授权已失效' }
      const path = selector.item
      if (selector.kind === 'folder') {
        const value = await hostRequest('agent.files.openFolder', { path, referenceOnly: selector.reference_only === true }, signal)
        signal.throwIfAborted()
        if (!await authorize(identity)) return { error: '当前文件夹打开授权已失效' }
        return value as { file: { name: string; ext: string; referenceId: string; location: { kind: 'host_absolute'; value: string } } } | { error: string }
      }
      let referenceId: string | undefined
      const hostPath = isHostFilePath(path)
      if (hostPath) {
        const { references } = await readDesktopTurnReferences(db, identity)
        for (const ref of references.slice(0, 6)) {
          if (ref?.type !== 'file' || typeof ref.id !== 'string' || !workspaceFileReferenceId.test(ref.id)) continue
          if ((await resolveReferencedFile(ref.id, signal))?.path !== path) continue
          referenceId = ref.id
          break
        }
      }
      let external: { path: string; identity: string } | undefined
      if (batch && hostPath && !referenceId) {
        const result = await hostRequest('agent.files.libraryFileReference', { path }, signal)
        if (typeof result === 'string' && workspaceFileReferenceId.test(result)) referenceId = result
        if (!await authorize(identity)) return { error: '当前文件访问授权已失效' }
      }
      if (hostPath && !referenceId) {
        if (batch) return { error: '批量发送只能使用已授权的文件库对象，请单独发送需要额外授权的文件' }
        const result = await authorizeHostFile(path, selector, scope, call, call.name === 'send_item' ? sendItemConfirmation : presentConfirmation)
        if (!('target' in result)) return result
        external = result.target
      } else if (scope.resolution) return { error: '文件目标或授权已变化，请重新发起操作' }
      const target = external ? { path: external.path, hostIdentity: external.identity }
        : { path, ...(referenceId ? { referenceId } : {}) }
      const value: unknown = await hostRequest('agent.files.present', {
        ...target, ...(selector.reference_only ? { referenceOnly: true } : {}),
      }, signal)
      signal.throwIfAborted()
      if (!await authorize(identity)) return { error: '当前文件预览授权已失效' }
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: '文件不存在或无法预览' }
      const file = value as Record<string, unknown>
      if (typeof file.error === 'string') return { error: file.error }
      if (file.opened !== true || typeof file.name !== 'string' || typeof file.ext !== 'string')
        return { error: '文件不存在或无法预览' }
      return { file: { name: file.name, ext: file.ext,
        ...(typeof file.referenceId === 'string' ? { referenceId: file.referenceId } : {}),
        ...(typeof file.path === 'string' ? { location: { kind: 'host_absolute' as const, value: file.path } } : {}),
        surface: file.system === true ? 'system' : 'desktop' } }
    },
  }
  return { shell, deleteItem, presentFile, isHostFilePath, authorizeHostFile, shellConfirmation, deleteItemConfirmation,
    presentConfirmation, sendItemConfirmation, viewImageConfirmation }
}
