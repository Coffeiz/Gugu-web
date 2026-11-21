import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import type { IpcHost, IpcHandlers } from '../ipc/types.js'

export function projectsHandlers(host: IpcHost): IpcHandlers {
  return {
    [DESKTOP_CHANNELS.projects]: () => host.request('projects.list'),
    [DESKTOP_CHANNELS.createProject]: (name: unknown) =>
      host.request('projects.create', { name }),
    [DESKTOP_CHANNELS.renameProject]: (id: unknown, version: unknown, name: unknown) =>
      host.request('projects.rename', { id, version, name }),
    [DESKTOP_CHANNELS.projectBoard]: (collection, offset) => host.request('projects.board.list', { collection, offset }),
    [DESKTOP_CHANNELS.projectDetails]: id => host.request('projects.board.get', { id }),
    [DESKTOP_CHANNELS.createBoardProject]: (fields, operationId) =>
      host.request('projects.board.create', { fields }, operationId as string | undefined),
    [DESKTOP_CHANNELS.updateBoardProject]: (id, version, fields) =>
      host.request('projects.board.update', { id, version, fields }),
    [DESKTOP_CHANNELS.deleteBoardProject]: id => host.request('projects.board.delete', { id }),
    [DESKTOP_CHANNELS.restoreBoardProject]: id => host.request('projects.board.restore', { id }),
  }
}
