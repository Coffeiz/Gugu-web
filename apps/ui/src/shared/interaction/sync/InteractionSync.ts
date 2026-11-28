import { interactionSyncState, type InteractionMutation } from './InteractionSyncState'
import { beginOptimisticIntent, withOptimisticIntent } from '@/utils/optimisticIntent'
import { optimisticMutation } from '@/utils/optimisticMutation'
import type { InteractionSyncPolicy } from './InteractionSyncPolicy'

/** 领域 Store 使用的统一入口；业务仍拥有字段映射，统一层拥有身份、来源和 mutation 生命周期。 */
export const InteractionSync = {
  async execute<T>(policy: InteractionSyncPolicy<T>): Promise<T> {
    const mutation = interactionSyncState.begin(policy.scope, policy.entityKey, policy.clientKey)
    let result!: T
    try {
      await withOptimisticIntent(beginOptimisticIntent([policy.entityKey]), () => optimisticMutation({
        apply: policy.apply,
        rollback: policy.rollback,
        afterMutate: policy.afterMutate ?? (() => {}),
        work: async () => { result = await policy.request(mutation) },
        onCommit: () => policy.onCommit?.(result),
        onError: error => {
          policy.onError?.(error)
          throw error
        },
      }))
      return result
    } finally {
      interactionSyncState.finish(mutation.mutationId)
    }
  },
  begin(scope: string, entityKey: string, clientKey?: string): InteractionMutation {
    return interactionSyncState.begin(scope, entityKey, clientKey)
  },
  finish(mutationId: string): void { interactionSyncState.finish(mutationId) },
  cancel(mutationId: string): void { interactionSyncState.cancel(mutationId) },
  reset(): void { interactionSyncState.reset() },
  pending(): InteractionMutation[] { return interactionSyncState.listPending() },
  isOwnEvent(origin?: string | null): boolean { return interactionSyncState.isOwnEvent(origin) },
  get clientId(): string { return interactionSyncState.clientId },
}
