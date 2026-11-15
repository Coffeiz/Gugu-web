import { CoreError, dataContext } from '../contracts/index.js'
import type { WorkspaceDeclaration } from './workspace-declarations.js'

export interface WorkspaceSessionBinding { id: number; workspaceId: number | null }
export interface WorkspaceBindingTransaction {
  /** PG需锁定owner内会话行；SQLite由注入的写事务边界保护。 */
  getOwnedSession(ownerId: string, sessionId: number): Promise<WorkspaceSessionBinding | null>
  workspaceForOwner(ownerId: string, workspaceId: number, requireEnabled: boolean): Promise<WorkspaceDeclaration | null>
  setWorkspace(ownerId: string, sessionId: number, workspaceId: number | null): Promise<void>
}
export interface WorkspaceBindingRuntime {
  transaction<T>(work: (tx: WorkspaceBindingTransaction) => Promise<T>, options?: { signal?: AbortSignal }): Promise<T>
}
export interface WorkspaceBindingOptions { readonly signal?: AbortSignal }
export interface WorkspaceBindingOperations {
  bind(ownerId: string, workspaceId: number, sessionId: number, options?: WorkspaceBindingOptions): Promise<WorkspaceDeclaration>
  unbind(ownerId: string, sessionId: number, options?: WorkspaceBindingOptions): Promise<void>
  current(ownerId: string, sessionId: number, options?: WorkspaceBindingOptions): Promise<WorkspaceDeclaration | null>
}
function owner(raw: string): string {
  try { return dataContext(raw).ownerId }
  catch { throw new CoreError('invalid_request', '用户 ID 无效') }
}
function id(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) throw new CoreError('invalid_request', `${label} 无效`)
}

/** 只管理声明与会话绑定，不授予文件/执行权限，也不创建或删除物理目录。 */
export function createWorkspaceBindings(runtime: WorkspaceBindingRuntime): WorkspaceBindingOperations {
  function inSession<T>(ownerId: string, sessionId: number, signal: AbortSignal | undefined,
    work: (tx: WorkspaceBindingTransaction, session: WorkspaceSessionBinding) => Promise<T>): Promise<T> {
    return runtime.transaction(async tx => {
      signal?.throwIfAborted()
      const session = await tx.getOwnedSession(ownerId, sessionId)
      signal?.throwIfAborted()
      if (!session) throw new CoreError('not_found', '会话不存在')
      const result = await work(tx, session)
      signal?.throwIfAborted()
      return result
    }, { signal })
  }
  return {
    async bind(rawOwner, workspaceId, sessionId, options = {}) {
      const signal = options.signal
      signal?.throwIfAborted()
      const ownerId = owner(rawOwner)
      id(workspaceId, '工作区 ID'); id(sessionId, '会话 ID')
      return inSession(ownerId, sessionId, signal, async tx => {
        const workspace = await tx.workspaceForOwner(ownerId, workspaceId, true)
        signal?.throwIfAborted()
        if (!workspace) throw new CoreError('not_found', '工作区不存在或已停用')
        await tx.setWorkspace(ownerId, sessionId, workspace.id)
        // 保留既有HTTP绑定回执，不把这次选择解释为实际总绑定数。
        return { ...workspace, boundSessionCount: 1 }
      })
    },
    async unbind(rawOwner, sessionId, options = {}) {
      const signal = options.signal
      signal?.throwIfAborted()
      const ownerId = owner(rawOwner)
      id(sessionId, '会话 ID')
      await inSession(ownerId, sessionId, signal, tx => tx.setWorkspace(ownerId, sessionId, null))
    },
    async current(rawOwner, sessionId, options = {}) {
      const signal = options.signal
      signal?.throwIfAborted()
      const ownerId = owner(rawOwner)
      id(sessionId, '会话 ID')
      const workspace = await inSession(ownerId, sessionId, signal, async (tx, session) =>
        session.workspaceId === null ? null : tx.workspaceForOwner(ownerId, session.workspaceId, false))
      signal?.throwIfAborted()
      return workspace
    },
  }
}
