import type { FileSyncReconcileRunStatus } from '@/api/filesync'

const SKIPPED_FILE_ACTIVITY = 'filesyncAdmin.skippedFileActivity'

const RUN_STATUS_KEYS: Record<string, string> = {
  queued: 'filesyncAdmin.statusQueued',
  running: 'filesyncAdmin.statusRunning',
  paused: 'filesyncAdmin.statusPaused',
  cancelling: 'filesyncAdmin.statusCancelling',
  succeeded: 'filesyncAdmin.statusSucceeded',
  failed: 'filesyncAdmin.statusFailed',
  cancelled: 'filesyncAdmin.statusCancelled',
  interrupted: 'filesyncAdmin.statusInterrupted',
}

const RUN_REASON_KEYS: Record<string, string> = {
  bootstrap: 'filesyncAdmin.reasonBootstrap',
  daily: 'filesyncAdmin.reasonDaily',
  file_event: 'filesyncAdmin.reasonFileEvent',
  event_fallback: 'filesyncAdmin.reasonEventFallback',
  restart_recovery: 'filesyncAdmin.reasonRestartRecovery',
  manual: 'filesyncAdmin.reasonManual',
  snapshot_invalid: 'filesyncAdmin.reasonSnapshotInvalid',
}

const PAUSE_REASON_KEYS: Record<string, string> = {
  execution_budget: 'filesyncAdmin.pauseExecutionBudget',
  scan_slice: 'filesyncAdmin.pauseSlice',
  projection_slice: 'filesyncAdmin.pauseSlice',
  dirty_events: 'filesyncAdmin.pauseDirtyEvents',
}

const RUN_STAGE_KEYS: Record<string, string> = {
  claiming: 'filesyncAdmin.stageClaiming',
  scanning: 'filesyncAdmin.stageScanning',
  projecting: 'filesyncAdmin.stageProjecting',
  paused: 'filesyncAdmin.stagePaused',
  finished: 'filesyncAdmin.stageFinished',
}

export function filesyncRunStatusKey(run: Pick<FileSyncReconcileRunStatus, 'status' | 'errorCode'>): string | null {
  if (run.errorCode === 'skipped_file_active') return SKIPPED_FILE_ACTIVITY
  return RUN_STATUS_KEYS[run.status] ?? null
}

export function filesyncCycleDecisionKey(decision: string | null): string | null {
  if (decision === 'skipped_file_active') return SKIPPED_FILE_ACTIVITY
  return decision === 'scan' ? 'filesyncAdmin.cycleScan' : null
}

export function filesyncRunReasonKey(reason: string): string | null {
  return RUN_REASON_KEYS[reason] ?? null
}

export function filesyncRunStageKey(stage: string | null): string | null {
  return stage ? RUN_STAGE_KEYS[stage] ?? null : null
}

export function filesyncPauseReasonKey(reason: string): string | null {
  return PAUSE_REASON_KEYS[reason] ?? null
}
