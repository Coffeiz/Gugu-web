import { CoreError, dataContext } from '../../contracts/index.js'

export interface AgentSessionRepository {
  rename(ownerId: string, sessionId: number, title: string): Promise<{ id: number; title: string; title_locked: boolean } | null>
  locate(ownerId: string, messageId: number): Promise<{ id: number; sessionId: number } | null>
}

export function normalizeAgentSessionTitle(value: unknown): string {
  if (typeof value !== 'string') throw new CoreError('invalid_request', '标题必须为文本')
  const title = value.trim()
  if (!title) throw new CoreError('invalid_request', '标题不能为空')
  if (Array.from(title).length > 300) throw new CoreError('invalid_request', '标题过长')
  return title
}

/** 不存在与越权保持同一结果；可信 owner 必须由 Host 提供。 */
export function createAgentSessionApplication(repository: AgentSessionRepository) {
  return {
    async rename(ownerId: string, sessionId: number, value: unknown) {
      const owner = dataContext(ownerId).ownerId
      if (!Number.isSafeInteger(sessionId)) throw new CoreError('invalid_request', '会话 ID 无效')
      const title = normalizeAgentSessionTitle(value)
      return repository.rename(owner, sessionId, title)
    },
    async locate(ownerId: string, messageId: number) {
      const owner = dataContext(ownerId).ownerId
      if (!Number.isSafeInteger(messageId)) throw new CoreError('invalid_request', '消息 ID 无效')
      return repository.locate(owner, messageId)
    },
  }
}
