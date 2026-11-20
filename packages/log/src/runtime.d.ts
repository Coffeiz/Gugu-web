export type RuntimeEvent =
  | 'host.shutdown_requested' | 'host.shutdown_phase_started' | 'host.shutdown_phase_finished'
  | 'host.shutdown_phase_slow' | 'host.shutdown_phase_failed'
  | 'host.started' | 'host.stopped' | 'host.start_failed' | 'host.stop_failed'
  | 'host.database_unavailable' | 'host.rag_unavailable'
  | 'host.trash_purge_unavailable' | 'host.search_usage_unavailable'
  | 'gateway.started' | 'gateway.stopped' | 'gateway.start_failed' | 'gateway.stop_failed' | 'gateway.degraded'
  | 'gateway.rag_timeout' | 'gateway.rag_late_completion'
  | 'sandbox.probe_failed' | 'sandbox.command_failed' | 'sandbox.system_completed'

export type ShutdownPhase = 'http' | 'gateway' | 'account_memory' | 'workers' | 'scheduled_runs' | 'agent_runs'
  | 'mcp' | 'embedding_rebuild' | 'embedding_transport' | 'loopscope' | 'loopscope_transport' | 'im_transports'
  | 'im_delivery_pool' | 'project_journal_pool' | 'core' | 'postgres_pool'

export type RuntimeLog = (event: RuntimeEvent, details?: {
  phase?: ShutdownPhase
  signal?: 'SIGINT' | 'SIGTERM'
  elapsedMs?: number
  pid?: number
  error?: unknown
  code?: string
  ok?: boolean
  timedOut?: boolean
}) => void

export function createRuntimeLog(sinks: {
  regular(line: string): void
  diagnostic(line: string): void
}): RuntimeLog
