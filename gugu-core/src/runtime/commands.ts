import { CoreError } from '../contracts/index.js'
import type { Fields } from '../contracts/index.js'
import type { DataServices } from '../application/services.js'
import { object, onlyFields, safeInteger } from '../domain/values.js'

export const DESKTOP_METHODS = [
  'core.info',
  'projects.list',
  'projects.create',
  'projects.rename',
  'clients.list',
  'clients.create',
  'operations.get',
] as const
export function isMutation(method: string): boolean {
  return [
    'projects.create',
    'projects.rename',
    'projects.update',
    'clients.create',
    'clients.update',
    'clients.delete',
    'projects.createWithClient',
  ].includes(method)
}
const commandFields: Readonly<Record<string, readonly string[]>> = {
  'projects.list': ['archived'],
  'projects.rename': ['id', 'version', 'name'],
  'projects.update': ['id', 'version', 'fields'],
  'clients.list': [],
  'clients.update': ['id', 'fields'],
  'clients.delete': ['id'],
  'projects.createWithClient': ['project', 'client'],
  'operations.get': ['operation_id'],
}
// stdio 和直接使用 Worker 的宿主复用同一组参数规则；身份由宿主绑定。
export function validateCommandParams(method: string, params: Fields): void {
  object(params)
  if ('owner_id' in params || 'user_id' in params || 'ownerId' in params)
    throw new CoreError('invalid_request', '桌面请求参数无效')
  const allowed = Object.hasOwn(commandFields, method) ? commandFields[method] : undefined
  if (allowed) onlyFields(params, allowed)
}
export async function execute(
  data: DataServices,
  method: string,
  params: Fields,
): Promise<unknown> {
  validateCommandParams(method, params)
  switch (method) {
    case 'projects.list':
      if ('archived' in params && typeof params.archived !== 'boolean')
        throw new CoreError('invalid_request', '归档状态无效')
      return data.projects.list(params.archived as boolean | undefined)
    case 'projects.create':
      return data.projects.create(params)
    case 'projects.rename':
      return data.projects.update(safeInteger(params.id), safeInteger(params.version), {
        name: params.name,
      })
    case 'projects.update':
      object(params.fields)
      return data.projects.update(
        safeInteger(params.id),
        safeInteger(params.version),
        params.fields,
      )
    case 'clients.list':
      return data.clients.list()
    case 'clients.create':
      return data.clients.create(params)
    case 'clients.update':
      object(params.fields)
      return data.clients.update(safeInteger(params.id), params.fields)
    case 'clients.delete':
      await data.clients.delete(safeInteger(params.id))
      return null
    case 'projects.createWithClient': {
      object(params.project)
      object(params.client)
      const project = await data.projects.create(params.project),
        client = await data.clients.create(params.client)
      return { project, client }
    }
    default:
      throw new CoreError('invalid_request', '此 Core 能力不可用')
  }
}
