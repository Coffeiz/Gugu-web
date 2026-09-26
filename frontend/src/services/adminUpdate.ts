import { useAdminStore } from '@/stores/admin'

export interface UpdateCandidate {
  version: string
  channel: string
  minimum_version: string
  app_image?: string
  architectures: string[]
  database_migration: boolean
  release_notes_url: string
  rollback_supported: boolean
  git_sha?: string
  published_at?: string
  manifest_sha256: string
}

export interface UpdateTask {
  id: string
  operation: 'update' | 'rollback'
  version: string
  status: string
  stage: string
  progress: number
  message: string
  failure_code?: string | null
  requested_by?: string
  created_at?: string
  updated_at?: string
  completed_at?: string
  rollback_supported?: boolean
  previous_version?: string
  events?: Array<{ stage: string; at: string }>
}

export interface UpdateStatus {
  enabled: boolean
  mode: 'integrated_compose' | 'split_compose' | 'standalone_docker' | 'unknown'
  capability: 'one_click' | 'manual'
  reason_code: string
  reason: string
  current: { version: string } | null
  candidate: UpdateCandidate | null
  has_update: boolean
  task: UpdateTask | null
  history: UpdateTask[]
}

export interface UpdateCheck {
  has_update: boolean
  current: { version: string }
  candidate: UpdateCandidate
}

export interface UpdatePreflight {
  ready: boolean
  has_update: boolean
  candidate: UpdateCandidate | null
  current: { version: string }
  checks: Array<{ key: string; ok: boolean; detail: string }>
  challenge?: string
  challenge_expires_at?: string
}

export interface RollbackPreflight {
  ready: boolean
  target_version: string
  detail: string
  challenge?: string
}

async function request<T>(path: string, method = 'GET', body?: Record<string, unknown>): Promise<T> {
  const adminStore = useAdminStore()
  const response = await adminStore.authFetch(`/api/v1/admin/update${path}`, {
    method,
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const data = await response.json().catch(() => ({})) as { detail?: string }
  if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`)
  return data as T
}

export const adminUpdateService = {
  status: () => request<UpdateStatus>('/status'),
  check: () => request<UpdateCheck>('/check', 'POST', {}),
  preflight: () => request<UpdatePreflight>('/preflight', 'POST', {}),
  start: (challenge: string, manifest_sha256: string) =>
    request<{ accepted: boolean; task: UpdateTask }>('/start', 'POST', { challenge, manifest_sha256 }),
  rollbackPreflight: () => request<RollbackPreflight>('/rollback/preflight', 'POST', {}),
  rollback: (challenge: string) =>
    request<{ accepted: boolean; task: UpdateTask }>('/rollback', 'POST', { challenge }),
}
