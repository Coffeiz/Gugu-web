import { del, get, patch, post } from '@/api/client'
import type { ProjectAccess } from '@/api/projects'

export const webProjectAccess: ProjectAccess = {
  storesProjectsLocally: false,
  list: (archived = false, deleted = false) =>
    get(`/projects${archived ? '?archived=true' : deleted ? '?deleted=true' : ''}`),
  fileCounts: () => get('/projects/file-counts'),
  get: id => get(`/projects/${id}`),
  create: (data, idempotencyKey) =>
    post('/projects', data, idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : undefined),
  update: (id, data, meta) => patch(`/projects/${id}`, data, meta),
  delete: id => del(`/projects/${id}`),
  restore: id => post(`/projects/${id}/restore`),
}
