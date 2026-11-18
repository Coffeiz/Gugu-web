import type { components } from '@/types/api'
import { del, get, patch, post, type RequestMeta } from '@/api/client'
import { desktopData, isDesktopRenderer } from '@/desktop/bridge'

type Schemas = components['schemas']

export const projectsApi = {
  list: (archived = false, deleted = false) =>
    isDesktopRenderer()
      ? desktopData.projectBoard(archived ? 'archived' : deleted ? 'deleted' : 'active')
      : get<Schemas['ProjectResponse'][]>(
        `/projects${archived ? '?archived=true' : deleted ? '?deleted=true' : ''}`,
      ),
  fileCounts: () => get<{ projectId: number; fileCount: number }[]>('/projects/file-counts'),
  get: (id: number) => isDesktopRenderer() ? desktopData.projectDetails(id) : get<Schemas['ProjectResponse']>(`/projects/${id}`),
  create: (data: Schemas['ProjectCreate'], idempotencyKey?: string) =>
    isDesktopRenderer() ? desktopData.createBoardProject(data, idempotencyKey?.startsWith('project-') ? undefined : idempotencyKey) : post<Schemas['ProjectResponse']>(
      '/projects', data, idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : undefined,
    ),
  async update(id: number, data: Schemas['ProjectUpdate'], meta?: RequestMeta) {
    if (!isDesktopRenderer()) return patch<Schemas['ProjectResponse']>(`/projects/${id}`, data, meta)
    const { version, ...fields } = data
    if (version == null) throw new Error('缺少项目版本，请重新加载项目')
    return desktopData.updateBoardProject(id, version, fields)
  },
  delete: (id: number) => isDesktopRenderer() ? desktopData.deleteBoardProject(id) : del(`/projects/${id}`),
  restore: (id: number) => isDesktopRenderer() ? desktopData.restoreBoardProject(id) : post<Schemas['ProjectResponse']>(`/projects/${id}/restore`),
}
