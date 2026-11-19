import { randomUUID } from 'node:crypto'
import { errorFrames, failureCode } from './redact.js'

const levels = new Map(Object.entries({
  'host.started': 'info', 'host.stopped': 'info', 'host.start_failed': 'error',
  'host.stop_failed': 'error', 'host.database_unavailable': 'warn', 'host.rag_unavailable': 'warn',
  'gateway.started': 'info', 'gateway.stopped': 'info', 'gateway.start_failed': 'error',
  'gateway.stop_failed': 'error', 'gateway.degraded': 'warn',
  'sandbox.probe_failed': 'warn', 'sandbox.command_failed': 'warn', 'sandbox.system_completed': 'info',
}))
const conditions = new Set((
  'binding_post_commit_pending cleanup_failed compact_unavailable delivery_pending im_compaction_failed ' +
  'im_history_retention_failed im_history_storage_cleanup_failed im_provider_failed im_retention_failed ' +
  'im_retention_pending_unknown im_runtime_event_pending im_video_failed im_voice_failed interaction_wake_pending ' +
  'dispatch_unavailable delivery_unavailable pending_unavailable interaction_unavailable maintenance_unavailable ' +
  'message_failed notify_pending ownership_lost pending_ask_notify_pending poll post queue_unavailable ' +
  'reflection_dead reflection_deferred reflection_notification_pending reflection_retry reflection_usage_unknown ' +
  'secret_wake_pending session_delete_cleanup_pending session_delete_notification_pending ' +
  'shortcut_notification_pending shortcut_read_unavailable start stop typing poll-unavailable'
).split(' '))

export function createRuntimeLog({ regular, diagnostic }) {
  const write = (sink, record) => {
    try { sink(JSON.stringify(record) + '\n') }
    catch { /* 观测失败不改变宿主运行结果。 */ }
  }
  return (event, details = {}) => {
    if (!levels.has(event)) return
    const { error, code, ok, timedOut } = details
    const incident = error === undefined ? undefined : randomUUID()
    const attributes = {
      ...(event === 'gateway.degraded' && code !== undefined ? { code: conditions.has(code) ? code : 'unknown' } : {}),
      ...(incident ? { errorCode: failureCode(error) } : {}),
      ...(event === 'sandbox.system_completed' && typeof ok === 'boolean' ? { ok } : {}),
      ...(event === 'sandbox.system_completed' && typeof timedOut === 'boolean' ? { timedOut } : {}),
    }
    const record = { time: new Date().toISOString(), level: levels.get(event), event,
      ...(incident ? { incident } : {}), ...(Object.keys(attributes).length ? { attributes } : {}) }
    write(regular, record)
    if (incident) write(diagnostic, { ...record, frames: errorFrames(error) })
  }
}
