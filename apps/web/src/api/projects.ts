import type { components } from '@/types/api'
import { del, get, patch, post, type RequestMeta } from '@/api/client'

type Schemas = components['schemas']

export const projectsApi = {
  list: (archived = false, deleted = false) =>
    get<Schemas['ProjectResponse'][]>(`/projects${archived ? '?archived=true' : deleted ? '?deleted=true' : ''}`),
  fileCounts: () => get<{ projectId: number; fileCount: number }[]>('/projects/file-counts'),
  get: (id: number) => get<Schemas['ProjectResponse']>(`/projects/${id}`),
  create: (data: Schemas['ProjectCreate'], idempotencyKey?: string) =>
    post<Schemas['ProjectResponse']>(
      '/projects', data, idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : undefined,
    ),
  update: (id: number, data: Schemas['ProjectUpdate'], meta?: RequestMeta) =>
    patch<Schemas['ProjectResponse']>(`/projects/${id}`, data, meta),
  delete: (id: number) => del(`/projects/${id}`),
  restore: (id: number) => post<Schemas['ProjectResponse']>(`/projects/${id}/restore`),
}
