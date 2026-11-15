import { CoreError, dataContext } from '../contracts/index.js'

export interface WorkspaceDeleteResult { ok: true; workspaceId: number }
export interface WorkspaceDeletionTransaction {
  /** PG锁定本owner声明行；SQLite依赖调用方提供的写事务。 */
  lockOwnedWorkspace(ownerId: string, workspaceId: number): Promise<boolean>
  detachSessions(ownerId: string, workspaceId: number): Promise<void>
  /** 仅停用并解绑event_id为空的普通任务，不改变关联提醒。 */
  disableOrdinaryTasks(ownerId: string, workspaceId: number): Promise<void>
  deleteDeclaration(ownerId: string, workspaceId: number): Promise<void>
}
export interface WorkspaceDeletionRuntime {
  transaction<T>(work: (tx: WorkspaceDeletionTransaction) => Promise<T>, options?: { signal?: AbortSignal }): Promise<T>
}

/** 删除声明及显式绑定，不删除父资源、文件或物理目录，不授予工具确认权限。 */
export function createWorkspaceDeleter(runtime: WorkspaceDeletionRuntime) {
  return async (rawOwnerId: string, workspaceId: number, options: { signal?: AbortSignal } = {}): Promise<WorkspaceDeleteResult> => {
    const signal = options.signal
    signal?.throwIfAborted()
    let ownerId: string
    try { ownerId = dataContext(rawOwnerId).ownerId }
    catch { throw new CoreError('invalid_request', '用户 ID 无效') }
    if (!Number.isSafeInteger(workspaceId)) throw new CoreError('invalid_request', '工作区 ID 无效')
    return runtime.transaction(async tx => {
      signal?.throwIfAborted()
      const exists = await tx.lockOwnedWorkspace(ownerId, workspaceId)
      signal?.throwIfAborted()
      if (!exists) throw new CoreError('not_found', '工作区不存在')
      await tx.detachSessions(ownerId, workspaceId)
      signal?.throwIfAborted()
      await tx.disableOrdinaryTasks(ownerId, workspaceId)
      signal?.throwIfAborted()
      await tx.deleteDeclaration(ownerId, workspaceId)
      signal?.throwIfAborted()
      return { ok: true, workspaceId }
    }, { signal })
  }
}
