import type { RunIdentity } from './models.js'

export type AgentRunLogEventName =
  | 'agent.run.started'
  | 'agent.run.resumed'
  | 'agent.run.continued'
  | 'agent.run.finished'
  | 'agent.provider.retry'
  | 'agent.provider.error'
  | 'agent.provider.incomplete'
  | 'agent.provider.empty'
  | 'agent.provider.round_result'
  | 'agent.context.compaction_failed'
  | 'agent.context.compaction_skipped'
  | 'agent.context.overflow_recovery'
  | 'agent.tools.parallel_batch'
  | 'agent.tools.serial_batch'
  | 'agent.tools.invocation'
  | 'agent.tools.dispatch_failed'
  | 'agent.tools.schema_error'
  | 'agent.tools.shell_unavailable'
  | 'agent.reply_gate.blocked'
  | 'agent.interaction.confirm_replay_failed'
  | 'agent.interaction.activation_failed'
  | 'agent.interaction.result_missing'
  | 'agent.run.round_limit'
  | 'agent.run.finalization_failed'

export interface AgentRunLogEvent {
  readonly identity: RunIdentity
  readonly at: number
  readonly level: 'info' | 'warn' | 'error'
  readonly event: AgentRunLogEventName
  readonly round?: number
  /** 只允许结构化数字、布尔值或固定枚举；不得写入正文、参数或异常信息。 */
  readonly attributes?: Readonly<Record<string, string | number | boolean | null>>
}

export interface AgentRunLogPort {
  write(event: AgentRunLogEvent): void
}

/** 普通日志 best-effort；日志故障不能改变 Run 行为。 */
export function recordAgentRunLog(port: AgentRunLogPort | undefined, event: AgentRunLogEvent): void {
  if (!port) return
  try { port.write(event) }
  catch { /* 日志失败不影响 Agent 主链路。 */ }
}
