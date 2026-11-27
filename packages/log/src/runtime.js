import { writeLogRecord } from './jsonl.js'
import { randomUUID } from 'node:crypto'
import { errorFrames, failureCode } from './redact.js'
export { errorFrames } from './redact.js'

const levels = new Map(Object.entries({
  'host.started': 'info', 'host.stopped': 'info', 'host.start_failed': 'error',
  'host.shutdown_requested': 'info', 'host.shutdown_phase_started': 'info', 'host.shutdown_phase_finished': 'info',
  'host.shutdown_phase_slow': 'warn', 'host.shutdown_phase_failed': 'error',
  'host.core_worker_exit': 'error',
  'host.stop_failed': 'error', 'host.database_unavailable': 'warn', 'host.rag_unavailable': 'warn',
  'scheduled_tasks.check_failed': 'warn',
  'web_push.failed': 'warn',
  'host.trash_purge_unavailable': 'warn', 'host.search_usage_unavailable': 'warn',
  'gateway.started': 'info', 'gateway.stopped': 'info', 'gateway.start_failed': 'error',
  'gateway.qq_upload_timing': 'info',
  'gateway.qq_upload_failed': 'warn', 'gateway.qq_file_message_failed': 'warn',
  'gateway.qq_file_delivery_started': 'info',
  'gateway.qq_file_delivery_result': 'info',
  'gateway.stop_failed': 'error', 'gateway.degraded': 'warn',
  'gateway.rag_timeout': 'warn', 'gateway.rag_late_completion': 'info',
  'sandbox.probe_failed': 'warn', 'sandbox.command_failed': 'warn', 'sandbox.system_completed': 'info',
}))
const conditions = new Set((
  'binding_post_commit_pending cleanup_failed compact_unavailable delivery_pending im_compaction_failed ' +
  'im_history_retention_failed im_history_storage_cleanup_failed im_provider_failed im_run_failed im_retention_failed ' +
  'im_retention_pending_unknown im_runtime_event_pending im_video_failed im_voice_failed interaction_wake_pending interaction_callback_failed ' +
  'qq_interaction_message_unmatched qq_interaction_action_rejected qq-interaction-ack-failed ' +
  'dispatch_unavailable delivery_unavailable pending_unavailable interaction_unavailable maintenance_unavailable ' +
  'message_failed notify_pending ownership_lost pending_ask_notify_pending poll post queue_unavailable ' +
  'reflection_dead reflection_deferred reflection_notification_pending reflection_retry reflection_usage_unknown ' +
  'secret_wake_pending session_delete_cleanup_pending session_delete_notification_pending ' +
  'shortcut_notification_pending shortcut_read_unavailable start stop typing poll-unavailable ' +
  'config-unavailable listener-unavailable connection-failed cleanup-failed post-commit-pending qface-unavailable ' +
  'im_delivery_policy_changed im_dispatch_order_unavailable im_preferences_unavailable im_model_unavailable ' +
  'platform-unavailable admission-pending admission-unknown admission-unavailable callback-cleanup-pending ' +
  'telegram-poll-unavailable telegram-cleanup-failed telegram-media-notice-failed wechat-voice-notice-failed wechat-cleanup-failed wechat-poll-unavailable wechat-sender-unmatched wechat-start-notify-unavailable wechat-stop-notify-unavailable wechat-typing-ticket-unavailable wechat-typing-unavailable wechat-typing-revoked wechat-typing-stop-unavailable ' +
  'qq-connection-failed qq-event-failed qq-heartbeat-failed qq-heartbeat-timeout qq-cleanup-failed ' +
  'feishu-sdk-error feishu-sdk-warning feishu-misrouted-event feishu-event-failed feishu-cleanup-failed feishu-connection-failed'
).split(' '))

const dispatchRpcMethods = new Set([
  'im.inbox.prepare', 'im.inbox.reject', 'im.inbox.delivery', 'im.inbox.prompt',
  'agent.sessions.startRun', 'agent.sessions.events',
])
const dispatchErrorCodes = new Set(['invalid_request', 'storage_error', 'busy', 'result_too_large', 'unknown_result'])

const migrationConditions = new Set(['migration_incompatible', 'migration_pending', 'migration_unavailable', 'platform_unsupported'])
const migrationEvents = new Set(['host.rag_unavailable', 'host.trash_purge_unavailable', 'host.search_usage_unavailable'])

const shutdownPhases = new Set([
  'http', 'gateway', 'account_memory', 'web_push', 'workers', 'scheduled_runs', 'agent_runs', 'mcp',
  'embedding_rebuild', 'embedding_transport', 'loopscope', 'loopscope_transport', 'im_transports',
  'im_delivery_pool', 'project_journal_pool', 'core', 'postgres_pool',
])
const signals = new Set(['SIGINT', 'SIGTERM'])
const iLinkOperations = new Set([
  'getupdates', 'sendmessage', 'getuploadurl', 'getconfig', 'sendtyping',
  'msg/notifystart', 'msg/notifystop', 'close', 'configure',
])

/** iLink 错误本身已剥离请求与响应；日志边界仍只接受固定操作名和有限数值。 */
function safeILinkDetails(error) {
  if (!(error instanceof Error) || error.name !== 'ILinkApiError') return {}
  const operation = iLinkOperations.has(error.operation) ? error.operation : undefined
  const outcome = error.outcome === 'rejected' || error.outcome === 'unknown' ? error.outcome : undefined
  const statusCode = Number.isInteger(error.statusCode) && error.statusCode >= 100 && error.statusCode <= 599
    ? error.statusCode : undefined
  const ret = Number.isSafeInteger(error.ret) && error.ret >= -999999 && error.ret <= 999999 && error.ret !== 0
    ? error.ret : undefined
  return {
    ...(operation ? { upstreamOperation: operation } : {}),
    ...(outcome ? { upstreamOutcome: outcome } : {}),
    ...(statusCode !== undefined ? { httpStatus: statusCode } : {}),
    ...(ret !== undefined ? { upstreamRet: ret } : {}),
  }
}

export function createRuntimeLog({ regular, diagnostic, hostKind }) {
  return (event, details = {}) => {
    if (!levels.has(event)) return
    const { error, code, exitCode, frames, ok, timedOut, phase, signal, elapsedMs, pid, rpcMethod } = details
    const incident = error === undefined ? undefined : randomUUID()
    const allowedCodes = event === 'gateway.degraded' ? conditions : migrationEvents.has(event) ? migrationConditions : null
    const lifecycle = event.startsWith('host.shutdown_') || event === 'host.started' || event === 'host.stopped' || event === 'host.stop_failed'
    const dispatchFailure = event === 'gateway.degraded' && code === 'dispatch_unavailable'
    const errorCode = incident ? dispatchFailure && error instanceof Error && dispatchErrorCodes.has(error.code)
      ? error.code : failureCode(error) : undefined
    const mediaStatus = (code === 'qq-event-failed' && ['qq_media_address', 'qq_media_download'].includes(errorCode)
      || code === 'feishu-event-failed' && errorCode === 'feishu_media_download') ? error?.httpStatus : undefined
    const iLinkDetails = typeof code === 'string' && code.startsWith('wechat-') ? safeILinkDetails(error) : {}
    const { uploadStage, httpStatus, upstreamCode, deliveryOutcome } = details
    const attributes = {
      ...(['host.started', 'host.stopped'].includes(event) && hostKind === 'desktop' ? { hostKind } : {}),
      ...(event === 'gateway.qq_upload_timing' ? Object.fromEntries(
        ['prepareMs', 'transferMs', 'putMs', 'finishMs', 'completeMs', 'parts', 'concurrency', 'elapsedMs']
          .flatMap(key => {
            const value = details.uploadMetrics?.[key]
            return Number.isSafeInteger(value) && value >= 0 ? [[key, value]] : []
          }),
      ) : {}),
      ...(event === 'gateway.qq_file_delivery_result' && ['accepted', 'rejected', 'unknown'].includes(deliveryOutcome)
        ? { deliveryOutcome } : {}),
      ...(['gateway.qq_upload_failed', 'gateway.qq_file_message_failed'].includes(event) ? {
        ...(['input', 'prepare', 'part', 'finish', 'complete', 'close'].includes(uploadStage) ? { uploadStage } : {}),
        ...(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}),
        ...(Number.isSafeInteger(upstreamCode) ? { upstreamCode } : {}),
      } : {}),
      ...(event === 'host.core_worker_exit' && ['out_of_memory', 'uncaught_exception', 'unexpected_exit', 'watchdog_timeout'].includes(code)
        && Number.isSafeInteger(exitCode) ? { code, exitCode } : {}),
      ...(event.startsWith('host.shutdown_phase_') && shutdownPhases.has(phase) ? { phase } : {}),
      ...(lifecycle && signals.has(signal) ? { signal } : {}),
      ...(lifecycle && Number.isSafeInteger(elapsedMs) && elapsedMs >= 0 ? { elapsedMs } : {}),
      ...(lifecycle && Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
      ...(allowedCodes && code !== undefined ? { code: allowedCodes.has(code) ? code : 'unknown' } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(dispatchFailure && dispatchRpcMethods.has(rpcMethod) ? { rpcMethod } : {}),
      ...iLinkDetails,
      ...(Number.isInteger(mediaStatus) && mediaStatus >= 100 && mediaStatus <= 599 ? { httpStatus: mediaStatus } : {}),
      ...(event === 'sandbox.system_completed' && typeof ok === 'boolean' ? { ok } : {}),
      ...(event === 'sandbox.system_completed' && typeof timedOut === 'boolean' ? { timedOut } : {}),
    }
    const record = { time: new Date().toISOString(), level: levels.get(event), event,
      ...(incident ? { incident } : {}), ...(Object.keys(attributes).length ? { attributes } : {}) }
    writeLogRecord(regular, record)
    if (event === 'host.core_worker_exit' && attributes.code) {
      const locations = Array.isArray(frames) ? frames.slice(0, 8)
        .filter(frame => typeof frame === 'string' && /^[\w.-]{1,80}\.(?:[cm]?js|ts):\d{1,9}:\d{1,9}$/.test(frame)) : []
      writeLogRecord(diagnostic, { ...record, frames: locations })
    }
    if (incident) {
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined
      writeLogRecord(diagnostic, { ...record, frames: errorFrames(error),
        ...(cause ? { causeCode: failureCode(cause), causeFrames: errorFrames(cause) } : {}) })
    }
  }
}
