import type { CliClient, CliResult } from '../client/client.js'

export interface ProjectCommands {
  list(options?: { archived?: boolean; deleted?: boolean }, signal?: AbortSignal): Promise<CliResult<unknown>>
  get(id: number, signal?: AbortSignal): Promise<CliResult<unknown>>
  create(fields: Record<string, unknown>, signal?: AbortSignal): Promise<CliResult<unknown>>
  update(id: number, fields: Record<string, unknown>, signal?: AbortSignal): Promise<CliResult<unknown>>
  delete(id: number, signal?: AbortSignal): Promise<CliResult<unknown>>
  restore(id: number, signal?: AbortSignal): Promise<CliResult<unknown>>
}

/** 项目操作通过注入的宿主客户端执行，身份与权限由宿主校验。 */
export function createProjectCommands(client: CliClient): ProjectCommands {
  return {
    list: (options = {}, signal) => client.invoke('project', 'list', options, signal),
    get: (id, signal) => client.invoke('project', 'get', { id }, signal),
    create: (fields, signal) => client.invoke('project', 'create', { fields }, signal),
    update: (id, fields, signal) => client.invoke('project', 'update', { id, fields }, signal),
    delete: (id, signal) => client.invoke('project', 'delete', { id }, signal),
    restore: (id, signal) => client.invoke('project', 'restore', { id }, signal),
  }
}
