import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import type { IpcHost, IpcHandlers } from '../ipc/types.js'

export function notesHandlers(host: IpcHost): IpcHandlers {
  return {
    [DESKTOP_CHANNELS.notes]: () => host.request('mind.notes.list'),
    [DESKTOP_CHANNELS.createNote]: (contentMd: unknown, color: unknown) =>
      host.request('mind.notes.create', { contentMd, color }),
    [DESKTOP_CHANNELS.updateNote]: (id: unknown, fields: unknown) => host.request('mind.notes.update', { id, fields }),
    [DESKTOP_CHANNELS.deleteNote]: (id: unknown) => host.request('mind.notes.delete', { id }),
  }
}
