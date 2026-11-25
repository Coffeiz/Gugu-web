import type { ProjectAccess, ProjectWorkspaceBinding } from '@/api/projects'
import { desktopData, requestDesktopFile } from '../bridge/bridge'
import { pickDesktopWorkspace } from '../files/useDesktopWorkspaces'
import { i18n } from '@/i18n'
import { showAppNotice } from '@/composables/core/useAppToast'


export const desktopProjectAccess: ProjectAccess = {
  pickWorkspace: () => {
    if ('guguDesktop' in window) return pickDesktopWorkspace()
    showAppNotice(i18n.global.t('filesUi.addDesktopWorkspaceNative'))
    return Promise.resolve(null)
  },
  storesProjectsLocally: true,
  listWorkspaceBindings: async projectId =>
    await requestDesktopFile({ action: 'project-workspaces', projectId }) as ProjectWorkspaceBinding[],
  selectWorkspace: (projectId, directoryId) => {
    if (typeof directoryId !== 'string') throw new Error('桌面工作区标识无效')
    return requestDesktopFile({ action: 'project-workspace-binding', projectId, directoryId, bound: true })
  },
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
