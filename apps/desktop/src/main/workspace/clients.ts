import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import { DesktopError } from '../core-host.js'
import type { IpcHost, IpcHandlers } from '../ipc/types.js'

function contactFields(fields: unknown): Record<string, unknown> {
  if (typeof fields === 'string') return { name: fields }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields))
    throw new DesktopError('invalid_request', '联系人字段无效')
  return { ...fields }
}

export function clientsHandlers(host: IpcHost): IpcHandlers {
  return {
    [DESKTOP_CHANNELS.clients]: () => host.request('clients.list'),
    [DESKTOP_CHANNELS.clientRelated]: (id: unknown) => host.request('clients.related', { id }),
    [DESKTOP_CHANNELS.createClient]: (fields: unknown) =>
      host.request('clients.create', contactFields(fields)),
    [DESKTOP_CHANNELS.renameClient]: (id: unknown, fields: unknown) =>
      host.request('clients.update', { id, fields: contactFields(fields) }),
    [DESKTOP_CHANNELS.deleteClient]: (id: unknown) =>
      host.request('clients.delete', { id }),
  }
}
