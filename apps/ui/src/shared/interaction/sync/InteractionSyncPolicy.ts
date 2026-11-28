import type { InteractionMutation } from './InteractionSyncState'

/** 领域只描述字段如何改；同步时序、回滚和来源身份由 InteractionSync 统一负责。 */
export interface InteractionSyncPolicy<T> {
  scope: string
  entityKey: string
  clientKey?: string
  apply: () => void
  rollback: () => void
  request: (mutation: InteractionMutation) => Promise<T>
  afterMutate?: () => void
  onCommit?: (result: T) => void
  onError?: (error: unknown) => void
}
