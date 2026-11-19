export type RuntimeEvent =
  | 'host.started' | 'host.stopped' | 'host.start_failed' | 'host.stop_failed'
  | 'host.database_unavailable' | 'host.rag_unavailable'
  | 'gateway.started' | 'gateway.stopped' | 'gateway.start_failed' | 'gateway.stop_failed' | 'gateway.degraded'
  | 'sandbox.probe_failed' | 'sandbox.command_failed' | 'sandbox.system_completed'

export type RuntimeLog = (event: RuntimeEvent, details?: {
  error?: unknown
  code?: string
  ok?: boolean
  timedOut?: boolean
}) => void

export function createRuntimeLog(sinks: {
  regular(line: string): void
  diagnostic(line: string): void
}): RuntimeLog
