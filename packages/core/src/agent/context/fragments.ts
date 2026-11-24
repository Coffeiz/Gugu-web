export type ContextRegion = 'system' | 'snapshot' | 'turn'

export interface ContextModule<Scope, Value> {
  readonly id: string
  readonly region: ContextRegion
  readonly kind: 'instruction' | 'data'
  load(scope: Scope, signal: AbortSignal): Value | undefined | Promise<Value | undefined>
  /** 场景预算以自身单位计量，可选片段超出预算时整段省略。 */
  readonly budget?: { measure(value: Value): number; optional?: boolean }
}

export interface ContextFragment<Value> {
  readonly id: string
  readonly region: ContextRegion
  readonly kind: 'instruction' | 'data'
  readonly value: Value
}
