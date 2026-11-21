import type { ProjectAccess } from '@/api/projects'
import { desktopData } from '../bridge/bridge'

export const desktopProjectAccess: ProjectAccess = {
  storesProjectsLocally: true,
  list: (archived = false, deleted = false) => desktopData.projectBoard(archived ? 'archived' : deleted ? 'deleted' : 'active'),
  get: desktopData.projectDetails,
  create: (data, idempotencyKey) =>
    desktopData.createBoardProject(data, idempotencyKey?.startsWith('project-') ? undefined : idempotencyKey),
  async update(id, data) {
    const { version, ...fields } = data
    if (version == null) throw new Error('缺少项目版本，请重新加载项目')
    return desktopData.updateBoardProject(id, version, fields)
  },
  delete: desktopData.deleteBoardProject,
  purge: desktopData.purgeBoardProject,
  restore: desktopData.restoreBoardProject,
}
