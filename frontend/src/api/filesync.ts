/** Admin 文件同步 API 的类型和请求边界；页面不自行拼接同步业务请求。 */
export interface FileSyncBindingStatus {
  id: number
  userId: string
  source: string
  mode: string
  status: string
  protocolVersion: number
  rootPath: string
  revision: number
  watcherStatus: string
  needsReconcile: boolean
  healthRevision: number
  gapRevision: number
  healthErrorCode: string | null
  lastReconciledAt: string | null
  updatedAt: string | null
  pendingJournal: number
  failedJournal: number
  rejectedJournal: number
  pendingConflicts: number
  baselineGeneration: string | null
  lastDailyReconciledAt: string | null
  lastIntegrityVerifiedAt: string | null
  nextReconcileAt: string | null
  consecutiveFailures: number
}

export interface FileSyncConflictStatus {
  id: number
  bindingId: number
  userId: string
  relativePath: string
  source: string | null
  status: string
  hasBaseline: boolean
  hasLocal: boolean
  hasRemote: boolean
  createdAt: string | null
}

export interface FileSyncAdminStatus {
  featureEnabled: boolean
  backgroundReconcileEnabled: boolean
  storageBackend: string
  supported: boolean
  workspaceShellSupported: boolean
  ignoredBindingCount: number
  bindings: FileSyncBindingStatus[]
  conflicts: FileSyncConflictStatus[]
  reconcileRuns: FileSyncReconcileRunStatus[]
  userScanStates: FileSyncUserScanStateStatus[]
  failures: Array<{
    kind: string
    id: number
    bindingId?: number
    userId: string
    status: string
    operation: string
    errorCode: string
    attempts?: number
    updatedAt: string | null
  }>
  totals: {
    bindings: number
    journals: number
    pendingJournals: number
    failedJournals: number
    rejectedJournals: number
    pendingConflicts: number
    pendingOutbox: number
  }
  generatedAt: string
}

export interface FileSyncReconcileRunStatus {
  id: string
  bindingId: number
  userId?: string
  mode: string
  reason: string
  status: string
  stage: string | null
  dryRun: boolean
  allowDelete?: boolean
  progressCurrent: number
  progressTotal: number | null
  resultCounts: Record<string, number>
  errorCode: string | null
  pauseReason?: string | null
  nextRunAt?: string | null
  cumulativeRuntimeSeconds?: number
  createdAt?: string | null
  startedAt?: string | null
  finishedAt?: string | null
}

export interface FileSyncUserScanStateStatus {
  userId: string
  activitySeq: number
  lastFileActivityAt: string | null
  previousCycleCutoff: string | null
  currentCycleCutoff: string | null
  activityReliable: boolean
  lastCycleDecision: string | null
  skipReason: string | null
  lastRotationAt: string | null
  leaseUntil: string | null
}

export type FileSyncConflictResolution = 'keep_local' | 'keep_remote' | 'keep_both' | 'cancel'

type AdminFetch = (url: string, options?: RequestInit) => Promise<Response>

async function read<T>(request: Promise<Response>): Promise<T> {
  const response = await request
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `HTTP ${response.status}`)
  return data as T
}

export const filesyncAdminApi = {
  status: (fetcher: AdminFetch) => read<FileSyncAdminStatus>(fetcher('/api/v1/admin/filesync/status')),
  setEnabled: (fetcher: AdminFetch, enabled: boolean) => read<Record<string, unknown>>(fetcher('/api/v1/admin/config', {
    method: 'PATCH',
    body: JSON.stringify({ patch: { filesync: { enabled } } }),
  })),
  setBackgroundReconcileEnabled: (fetcher: AdminFetch, enabled: boolean) => read<Record<string, unknown>>(fetcher('/api/v1/admin/config', {
    method: 'PATCH',
    body: JSON.stringify({ patch: { filesync: { background_reconcile_enabled: enabled } } }),
  })),
  dryRun: (fetcher: AdminFetch, bindingId: number, integrityFull = false) => read<FileSyncReconcileRunStatus>(fetcher(`/api/v1/admin/filesync/bindings/${bindingId}/dry-run`, { method: 'POST', body: JSON.stringify({ integrityFull }) })),
  reconcile: (fetcher: AdminFetch, bindingId: number, integrityFull = false) => read<FileSyncReconcileRunStatus>(fetcher(`/api/v1/admin/filesync/bindings/${bindingId}/reconcile`, { method: 'POST', body: JSON.stringify({ confirm: true, integrityFull }) })),
  unbind: (fetcher: AdminFetch, bindingId: number) => read<{ id: number; status: string; scopeRevision: number }>(fetcher(`/api/v1/admin/filesync/bindings/${bindingId}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) })),
  run: (fetcher: AdminFetch, runId: string) => read<FileSyncReconcileRunStatus>(fetcher(`/api/v1/admin/filesync/runs/${runId}`)),
  cancel: (fetcher: AdminFetch, runId: string) => read<FileSyncReconcileRunStatus>(fetcher(`/api/v1/admin/filesync/runs/${runId}/cancel`, { method: 'POST' })),
  resolveConflict: (fetcher: AdminFetch, conflictId: number, resolution: FileSyncConflictResolution) => read<{ id: number; status: string; resolution: string }>(fetcher(`/api/v1/admin/filesync/conflicts/${conflictId}/resolve`, { method: 'POST', body: JSON.stringify({ resolution, confirm: resolution !== 'cancel' }) })),
}
