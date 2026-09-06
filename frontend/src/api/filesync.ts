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
  lastReconciledAt: string | null
  updatedAt: string | null
  pendingJournal: number
  failedJournal: number
  rejectedJournal: number
  pendingConflicts: number
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
  storageBackend: string
  supported: boolean
  workspaceShellSupported: boolean
  ignoredBindingCount: number
  bindings: FileSyncBindingStatus[]
  conflicts: FileSyncConflictStatus[]
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

export interface FileSyncActionResult {
  bindingId: number | null
  mode: string
  rootPath: string
  dryRun: boolean
  summary: Record<'scanned' | 'created' | 'updated' | 'moved' | 'deleted' | 'rejected' | 'conflicts', number>
  conflictIds: number[]
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
  dryRun: (fetcher: AdminFetch, bindingId: number) => read<FileSyncActionResult>(fetcher(`/api/v1/admin/filesync/bindings/${bindingId}/dry-run`, { method: 'POST' })),
  reconcile: (fetcher: AdminFetch, bindingId: number) => read<FileSyncActionResult>(fetcher(`/api/v1/admin/filesync/bindings/${bindingId}/reconcile`, { method: 'POST', body: JSON.stringify({ confirm: true }) })),
  resolveConflict: (fetcher: AdminFetch, conflictId: number, resolution: FileSyncConflictResolution) => read<{ id: number; status: string; resolution: string }>(fetcher(`/api/v1/admin/filesync/conflicts/${conflictId}/resolve`, { method: 'POST', body: JSON.stringify({ resolution, confirm: resolution !== 'cancel' }) })),
}
