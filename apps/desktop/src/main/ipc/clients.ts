import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import type { IpcHost, IpcHandlers } from './types.js'

export function clientsHandlers(host: IpcHost): IpcHandlers {
  return {
    [DESKTOP_CHANNELS.clients]: () => host.request('clients.list'),
    [DESKTOP_CHANNELS.createClient]: (name: unknown) =>
      host.request('clients.create', { name }),
    [DESKTOP_CHANNELS.renameClient]: (id: unknown, name: unknown) =>
      host.request('clients.update', { id, fields: { name } }),
    [DESKTOP_CHANNELS.deleteClient]: (id: unknown) =>
      host.request('clients.delete', { id }),
  }
}
