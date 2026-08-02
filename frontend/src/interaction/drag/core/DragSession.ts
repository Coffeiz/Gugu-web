export type DragPhase =
  | 'pressed'
  | 'dragging'
  | 'resolving-target'
  | 'layout-capturing'
  | 'business-committed'
  | 'layout-playing'
  | 'revealing'
  | 'landing'
  | 'handoff'
  | 'finished'
  | 'cancelled'

export type DragCleanup = () => void

/**
 * 一次拖拽的生命周期上下文。
 * 物理、视觉和业务状态不放进这里，避免 session 变成跨模块的状态垃圾桶。
 */
export class DragSession {
  readonly id: string
  readonly startedAt: number
  private _phase: DragPhase
  private handoffRequested = false
  private readonly cleanups = new Set<DragCleanup>()
  private currentChecker: () => boolean = () => false

  constructor(id: string, startedAt = Date.now()) {
    this.id = id
    this.startedAt = startedAt
    this._phase = 'pressed'
  }

  get phase(): DragPhase {
    return this._phase
  }

  setPhase(phase: DragPhase): void {
    if (this._phase === 'finished' || this._phase === 'cancelled') return
    this._phase = phase
  }

  bindCurrentChecker(checker: () => boolean): void {
    this.currentChecker = checker
  }

  isCurrent(): boolean {
    return !this.isTerminal() && this.currentChecker()
  }

  prepareHandoff(): void {
    if (!this.isTerminal()) this.handoffRequested = true
  }

  isHandoffRequested(): boolean {
    return this.handoffRequested
  }

  addCleanup(cleanup: DragCleanup): () => void {
    if (this.isTerminal()) {
      cleanup()
      return () => undefined
    }
    this.cleanups.add(cleanup)
    return () => this.cleanups.delete(cleanup)
  }

  finish(): void {
    this.close('finished')
  }

  cancel(): void {
    this.close('cancelled')
  }

  private isTerminal(): boolean {
    return this._phase === 'finished' || this._phase === 'cancelled'
  }

  private close(phase: 'finished' | 'cancelled'): void {
    if (this.isTerminal()) return
    this._phase = phase
    const cleanups = [...this.cleanups]
    this.cleanups.clear()
    for (const cleanup of cleanups) {
      try {
        cleanup()
      } catch {
        // 清理必须继续执行，单个视觉收尾失败不能阻断其它监听器卸载。
      }
    }
  }
}
