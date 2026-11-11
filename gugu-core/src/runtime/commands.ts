import { CoreError } from '../contracts/index.js'
import type { Fields } from '../contracts/index.js'
import type { DataServices } from '../application/services.js'
import { object, onlyFields, safeInteger } from '../domain/values.js'

export const DESKTOP_METHODS = ['core.info', 'projects.list', 'projects.create', 'projects.rename', 'clients.list', 'clients.create', 'operations.get'] as const
export function isMutation(method: string): boolean { return ['projects.create', 'projects.rename', 'projects.update', 'clients.create', 'clients.update', 'clients.delete', 'projects.createWithClient'].includes(method) }
export async function execute(data: DataServices, method: string, params: Fields): Promise<unknown> {
  object(params)
  if ('owner_id' in params || 'user_id' in params || 'ownerId' in params) throw new CoreError('invalid_request', '桌面请求参数无效')
  switch (method) {
    case 'projects.list': onlyFields(params, ['archived']); if ('archived' in params && typeof params.archived !== 'boolean') throw new CoreError('invalid_request', '归档状态无效'); return data.projects.list(params.archived as boolean | undefined)
    case 'projects.create': return data.projects.create(params)
    case 'projects.rename': onlyFields(params, ['id', 'version', 'name']); return data.projects.update(safeInteger(params.id), safeInteger(params.version), { name: params.name })
    case 'projects.update': object(params.fields); onlyFields(params, ['id', 'version', 'fields']); return data.projects.update(safeInteger(params.id), safeInteger(params.version), params.fields)
    case 'clients.list': onlyFields(params, []); return data.clients.list()
    case 'clients.create': return data.clients.create(params)
    case 'clients.update': object(params.fields); onlyFields(params, ['id', 'fields']); return data.clients.update(safeInteger(params.id), params.fields)
    case 'clients.delete': onlyFields(params, ['id']); await data.clients.delete(safeInteger(params.id)); return null
    case 'projects.createWithClient': {
      onlyFields(params, ['project', 'client']); object(params.project); object(params.client)
      const project = await data.projects.create(params.project), client = await data.clients.create(params.client)
      return { project, client }
    }
    default: throw new CoreError('invalid_request', '此 Core 能力不可用')
  }
}
