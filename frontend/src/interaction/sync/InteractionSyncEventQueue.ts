import type { LiveEventPayload } from '@/types/live-events'
import { InteractionSync } from './InteractionSync'

type EventHandler = (event: LiveEventPayload) => boolean

/** 实时事件统一先走增量合并，不能安全 patch 时再按资源合并一次刷新。 */
export class InteractionSyncEventQueue {
  private readonly handlers = new Map<string, EventHandler>()
  private readonly refreshers = new Map<string, () => void>()
  private readonly pending = new Set<string>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  register(resource: string, handler: EventHandler, refresh: () => void): () => void {
    this.handlers.set(resource, handler)
    this.refreshers.set(resource, refresh)
    return () => {
      if (this.handlers.get(resource) === handler) this.handlers.delete(resource)
      if (this.refreshers.get(resource) === refresh) this.refreshers.delete(resource)
      this.cancel(resource)
    }
  }

  receive(event: LiveEventPayload): 'echo' | 'applied' | 'queued' {
    if (InteractionSync.isOwnEvent(event.origin)) return 'echo'
    const handler = this.handlers.get(event.resource)
    if (handler?.(event)) return 'applied'
    this.enqueue(event.resource)
    return 'queued'
  }

  enqueue(resource: string, delay = 80): void {
    this.pending.add(resource)
    if (this.timers.has(resource)) return
    this.timers.set(resource, setTimeout(() => {
      this.timers.delete(resource)
      if (!this.pending.delete(resource)) return
      this.refreshers.get(resource)?.()
    }, delay))
  }

  flush(resource?: string): void {
    const resources = resource ? [resource] : [...this.pending]
    for (const current of resources) {
      const timer = this.timers.get(current)
      if (timer) clearTimeout(timer)
      this.timers.delete(current)
      if (this.pending.delete(current)) this.refreshers.get(current)?.()
    }
  }

  cancel(resource?: string): void {
    const resources = resource ? [resource] : [...this.timers.keys()]
    for (const current of resources) {
      const timer = this.timers.get(current)
      if (timer) clearTimeout(timer)
      this.timers.delete(current)
      this.pending.delete(current)
    }
  }
}
