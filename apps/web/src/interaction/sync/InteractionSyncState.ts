/** InteractionSync 的客户端身份和 mutation 生命周期。 */
export interface InteractionMutation {
  readonly mutationId: string
  readonly clientId: string
  readonly scope: string
  readonly entityKey: string
  readonly clientKey?: string
  nodeId?: number
  persistedItemId?: number
  cancelled?: boolean
}

const CLIENT_STORAGE_KEY = 'gugu.interaction.client-id'

function newId(prefix: string): string {
  const random = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${random}`
}

export function getInteractionClientId(): string {
  if (typeof window === 'undefined') return newId('client')
  try {
    const existing = window.sessionStorage.getItem(CLIENT_STORAGE_KEY)
    if (existing) return existing
    const clientId = newId('client')
    window.sessionStorage.setItem(CLIENT_STORAGE_KEY, clientId)
    return clientId
  } catch {
    return newId('client')
  }
}

export class InteractionSyncState {
  readonly clientId = getInteractionClientId()
  private readonly pending = new Map<string, InteractionMutation>()

  begin(scope: string, entityKey: string, clientKey?: string): InteractionMutation {
    const mutation: InteractionMutation = {
      mutationId: newId('mutation'), clientId: this.clientId, scope, entityKey, clientKey,
    }
    this.pending.set(mutation.mutationId, mutation)
    return mutation
  }

  finish(mutationId: string): void { this.pending.delete(mutationId) }
  cancel(mutationId: string): void {
    const mutation = this.pending.get(mutationId)
    if (mutation) mutation.cancelled = true
  }
  reset(): void { this.pending.clear() }
  listPending(): InteractionMutation[] { return [...this.pending.values()] }
  isOwnEvent(origin?: string | null): boolean { return !!origin && origin === this.clientId }
}

export const interactionSyncState = new InteractionSyncState()
