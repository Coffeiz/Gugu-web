import { CoreError, dataContext } from '../../contracts/index.js'

export interface AgentSessionStateRecord {
  executionState: string
  pendingMessageCount: number
}

export interface AgentSessionStatePorts {
  read(ownerId: string, sessionId: number): Promise<AgentSessionStateRecord | null>
  recover(ownerId: string, sessionId: number): Promise<unknown>
  isActive(sessionId: number): Promise<boolean>
}

/** 读取与 Python get_session_state 相同的 owner 快照，并按恢复后刷新、再检查运行态的顺序执行。 */
export function createAgentSessionStateReader(ports: AgentSessionStatePorts) {
  return async (rawOwnerId: string, sessionId: number) => {
    const ownerId = dataContext(rawOwnerId).ownerId
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) throw new CoreError('invalid_request', '会话 ID 无效')
    if (!await ports.read(ownerId, sessionId)) return null
    await ports.recover(ownerId, sessionId)
    const session = await ports.read(ownerId, sessionId)
    if (!session) return null
    const active = await ports.isActive(sessionId)
    return { executionState: session.executionState, pendingMessageCount: session.pendingMessageCount, active }
  }
}
