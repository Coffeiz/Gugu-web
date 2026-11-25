import { del, get, patch, post, put } from '@/api/client'
import type { ProjectAccess } from '@/api/projects'

export const webProjectAccess: ProjectAccess = {
  storesProjectsLocally: false,
  listWorkspaceBindings: id => get(`/projects/${id}/workspace-selection`),
  selectWorkspace(id, directoryId, workspaceId) {
    if (typeof directoryId === 'number' && workspaceId === undefined) throw new Error('缺少工作区标识')
    return put(`/projects/${id}/workspace-selection`, { workspaceId: workspaceId ?? null })
  },
  list: (archived = false, deleted = false) =>
    get(`/projects${archived ? '?archived=true' : deleted ? '?deleted=true' : ''}`),
  fileCounts: () => get('/projects/file-counts'),
  get: id => get(`/projects/${id}`),
  create: (data, idempotencyKey) =>
    post('/projects', data, idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : undefined),
  update: (id, data, meta) => patch(`/projects/${id}`, data, meta),
  delete: id => del(`/projects/${id}`),
  purge: id => del(`/projects/${id}/purge`),
  restore: id => post(`/projects/${id}/restore`),
}
