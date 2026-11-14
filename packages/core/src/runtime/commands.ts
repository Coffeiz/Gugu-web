import { CoreError, frameSchema } from '../contracts/index.js'
import type { Fields } from '../contracts/index.js'
import type { DataServices } from '../application/services.js'
import type { LocalRuntime } from './local.js'
import { object, onlyFields, safeInteger } from '../domain/values.js'
import { DESKTOP_METHODS, MAX_FRAME } from '../contracts/desktop.js'
export { DESKTOP_METHODS, MAX_FRAME } from '../contracts/desktop.js'

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
  'core.info': [],
  'executor.diagnostics': [],
  'projects.list': ['archived'],
  'projects.rename': ['id', 'version', 'name'],
  'projects.update': ['id', 'version', 'fields'],
  'clients.list': [],
  'clients.update': ['id', 'fields'],
  'clients.delete': ['id'],
  'projects.createWithClient': ['project', 'client'],
  'operations.get': ['operation_id'],
}

export function visibleError(error: unknown): {
  code: string
  message: string
} {
  if (error instanceof CoreError) {
    const messages: Record<string, string> = {
      conflict: '项目或操作已变化，请重新读取',
      not_found: '数据不存在',
      schema_upgrade_required: '数据库需要显式备份升级，请运行 Core migrate',
      cancelled: '操作已取消',
      busy: '本地数据队列已满',
      database_in_use: '数据库正由其他运行时使用，请先关闭其他实例',
    }
    if (messages[error.code]) return { code: error.code, message: messages[error.code]! }
    if (error.code === 'storage_error' || error.code === 'closed')
      return {
        code: 'storage_error',
        message: '本地数据操作失败，请重读数据确认状态',
      }
  }
  return {
    code: 'invalid_request',
    message: '桌面请求无效，请检查字段与能力范围',
  }
}
export function boundedFrame(value: Fields): string {
  const output = JSON.stringify(value)
  return Buffer.byteLength(output) + 1 <= MAX_FRAME
    ? output
    : JSON.stringify({
        v: value.v,
        id: value.id ?? null,
        error: { code: 'result_too_large', message: '结果超出桌面协议限制' },
      })
}
// 传输只处理帧；所有入口复用命令、身份和持久操作标识契约。
export async function desktopFrame(
  raw: unknown,
  runtime: Pick<LocalRuntime, 'call' | 'schemaVersion'>,
  protocol = 2,
): Promise<Fields> {
  let id: number | null = null
  try {
    const request = frameSchema.parse(raw)
    if (request.v !== protocol || (protocol === 1 && request.operation_id !== undefined))
      throw new CoreError('invalid_request', '协议版本不兼容')
    id = request.id
    if (
      !(DESKTOP_METHODS as readonly string[]).includes(request.method) ||
      (protocol === 1 && request.method === 'operations.get')
    )
      throw new CoreError('invalid_request', '此能力不可用')
    validateCommandParams(request.method, request.params)
    if (protocol === 2 && isMutation(request.method) && !request.operation_id)
      throw new CoreError('invalid_request', '写入必须提供稳定操作标识')
    if (
      protocol === 1 &&
      request.method.endsWith('.list') &&
      Object.keys(request.params).length
    )
      throw new CoreError('invalid_request', '列表参数无效')
    const result =
      request.method === 'executor.diagnostics'
        ? await (await import('../agent/executor/platform.js')).mxcDiagnostics()
        : request.method === 'core.info'
          ? {
              protocol,
              storage: 'sqlite',
              accountMode: 'single-user',
              ...(protocol === 2
                ? { implementation: 'node', schema: runtime.schemaVersion }
                : {}),
            }
          : await runtime.call(request.method, request.params, {
              operationId: request.operation_id,
            })
    return { v: protocol, id, result }
  } catch (error) {
    return { v: protocol, id, error: visibleError(error) }
  }
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
      return (await data.projects.list(params.archived as boolean | undefined)).map(
        ({ id, name, version }) => ({ id, name, version }),
      )
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
      return (await data.clients.list()).map(({ id, name }) => ({ id, name }))
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
