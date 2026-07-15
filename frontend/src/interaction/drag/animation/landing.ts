export type LandingPhase = 'idle' | 'settling' | 'finished' | 'cancelled'

/** 落地动画自身的状态，不包含 session、DOM 或业务目标引用。 */
export class LandingState {
  private _phase: LandingPhase = 'idle'

  get phase(): LandingPhase {
    return this._phase
  }

  begin(): void {
    if (this._phase === 'idle') this._phase = 'settling'
  }

  isDone(): boolean {
    return this._phase === 'finished' || this._phase === 'cancelled'
  }

  finish(): void {
    if (!this.isDone()) this._phase = 'finished'
  }

  cancel(): void {
    if (!this.isDone()) this._phase = 'cancelled'
  }
}
