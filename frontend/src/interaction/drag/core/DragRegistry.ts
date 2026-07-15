import { DragSession } from './DragSession'

let nextSessionId = 0

/**
 * 按源卡片隔离拖拽生命周期。
 * Registry 只知道 source 与 session 的关系，不持有 clone、目标或业务数据。
 */
export class DragRegistry {
  private readonly sessions = new WeakMap<HTMLElement, DragSession>()

  start(source: HTMLElement): DragSession {
    this.cancel(source)
    const session = new DragSession(`drag-${Date.now()}-${nextSessionId++}`)
    session.bindCurrentChecker(() => this.sessions.get(source) === session)
    this.sessions.set(source, session)
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
  }

  cancel(source: HTMLElement): void {
    const session = this.sessions.get(source)
    if (!session) return
    session.cancel()
    this.sessions.delete(source)
  }
}

export const dragRegistry = new DragRegistry()
