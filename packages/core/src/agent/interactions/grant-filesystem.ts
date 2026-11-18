import { CoreError, dataContext } from '../../contracts/index.js'

export interface SessionFilesystemGrantTransaction {
  /** 在当前事务内锁定 owner 会话，避免并发重复授权及撤销竞态。 */
  lockOwnedSession(ownerId: string, sessionId: number): Promise<boolean>
  hasActiveGrant(ownerId: string, sessionId: number, now: Date): Promise<boolean>
  insertGrant(ownerId: string, sessionId: number, grantedBy: 'user' | 'askuser', now: Date): Promise<number>
  recordGrant(ownerId: string, sessionId: number, grantId: number, grantedBy: 'user' | 'askuser', now: Date): Promise<void>
}

export interface SessionFilesystemGrantStore {
  transaction<T>(work: (tx: SessionFilesystemGrantTransaction) => Promise<T>): Promise<T>
}

/** Agent 交互确认后授予当前会话完整用户沙箱访问；SQL、开关与审计由 Host 适配。 */
export function createSessionFilesystemGrant(options: {
  store: SessionFilesystemGrantStore
  enabled(): boolean
  now?: () => Date
}) {
  if (!options.store || typeof options.store.transaction !== 'function' || typeof options.enabled !== 'function') throw new TypeError('文件系统授权服务未完整配置')
  const now = options.now ?? (() => new Date())
  return async (input: { ownerId: string; sessionId: number; grantedBy: 'user' | 'askuser' }) => {
    let ownerId: string
    try { ownerId = dataContext(input.ownerId).ownerId }
    catch { throw new CoreError('invalid_request', '用户 ID 无效') }
    if (!Number.isSafeInteger(input.sessionId) || input.sessionId <= 0) throw new CoreError('invalid_request', '会话 ID 无效')
    if (input.grantedBy !== 'user' && input.grantedBy !== 'askuser') throw new CoreError('invalid_request', '授权来源无效')
    if (!options.enabled()) throw new CoreError('conflict', '完整用户沙箱授权功能当前未开启')
    return options.store.transaction(async tx => {
      if (!await tx.lockOwnedSession(ownerId, input.sessionId)) throw new CoreError('not_found', '会话不存在')
      const grantedAt = now()
      if (await tx.hasActiveGrant(ownerId, input.sessionId, grantedAt)) return { status: 'confirmed' as const, text: '已授权当前会话完整读写用户沙箱（workspace、personal、project）。' }
      const grantId = await tx.insertGrant(ownerId, input.sessionId, input.grantedBy, grantedAt)
      await tx.recordGrant(ownerId, input.sessionId, grantId, input.grantedBy, grantedAt)
      return { status: 'confirmed' as const, text: '已授权当前会话完整读写用户沙箱（workspace、personal、project）。' }
    })
  }
}
