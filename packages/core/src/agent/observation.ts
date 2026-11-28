import type { RunIdentity, Usage } from './models.js'

/** 跨 Host 的 Agent 真实执行观测；接收实现必须尽力处理且不得阻塞。 */
export interface AgentObservation {
  readonly identity: RunIdentity
  readonly kind: 'run' | 'round' | 'provider' | 'tool' | 'context' | 'output' | 'history' | 'guard' | 'state'
  readonly name: string
  readonly at: number
  readonly round?: number
  readonly spanId?: string
  readonly parentSpanId?: string | null
  readonly status?: string
  readonly startedAt?: number
  readonly endedAt?: number | null
  readonly durationMs?: number | null
  readonly input?: unknown
  readonly output?: unknown
  readonly attributes?: Readonly<Record<string, unknown>>
  readonly usage?: Usage
}

/** 通用观测端口；Core 不依赖具体追踪服务或平台。 */
export interface AgentObservationPort {
  record(event: AgentObservation): void
}

export function recordAgentObservation(port: AgentObservationPort | undefined, event: AgentObservation): void {
  if (!port) return
  try { port.record(event) } catch { /* 观测失败不能影响 Agent Run。 */ }
}
