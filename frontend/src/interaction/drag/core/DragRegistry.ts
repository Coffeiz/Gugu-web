import { DragSession } from './DragSession'

let nextSessionId = 0

/**
 * 按源卡片隔离拖拽生命周期。
 * Registry 只知道 source 与 session 的关系，不持有 clone、目标或业务数据。
 */
export class DragRegistry {
  private readonly sessions = new WeakMap<HTMLElement, DragSession>()
  private readonly identitySessions = new Map<string, { source: HTMLElement; session: DragSession }>()

  private identity(source: HTMLElement): string | null {
    for (const attr of ['data-project-id', 'data-file-id', 'data-folder-key']) {
      const value = source.getAttribute(attr)
      if (value) return `${attr}:${value}`
    }
    return null
  }

  start(source: HTMLElement): DragSession {
    this.cancel(source)
    const identity = this.identity(source)
    const previous = identity ? this.identitySessions.get(identity) : undefined
    if (previous && previous.source !== source) {
      previous.session.cancel()
      this.sessions.delete(previous.source)
      if (identity) this.identitySessions.delete(identity)
    }
    const session = new DragSession(`drag-${Date.now()}-${nextSessionId++}`)
    session.bindCurrentChecker(() => this.sessions.get(source) === session)
    this.sessions.set(source, session)
    if (identity) this.identitySessions.set(identity, { source, session })
    return session
  }

  current(source: HTMLElement): DragSession | undefined {
    return this.sessions.get(source)
  }

  isCurrent(source: HTMLElement, session: DragSession): boolean {
    return this.sessions.get(source) === session && session.isCurrent()
  }

  finish(source: HTMLElement, session: DragSession): void {
    if (this.sessions.get(source) !== session) return
    session.finish()
    this.sessions.delete(source)
    const identity = this.identity(source)
    if (identity && this.identitySessions.get(identity)?.session === session) {
      this.identitySessions.delete(identity)
    }
  }

  cancel(source: HTMLElement): void {
    const session = this.sessions.get(source)
    if (!session) return
    session.cancel()
    this.sessions.delete(source)
    const identity = this.identity(source)
    if (identity && this.identitySessions.get(identity)?.session === session) {
      this.identitySessions.delete(identity)
    }
  }
}

export const dragRegistry = new DragRegistry()
