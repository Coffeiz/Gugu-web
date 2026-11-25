/** CLI 与宿主之间使用的版本化结果；业务数据由宿主提供。 */
export type CliResult<T> =
  | { version: 1; ok: true; data: T; error: null }
  | { version: 1; ok: false; data: null; error: { code: string; message: string } }

export type CliObject = 'project' | 'calendar' | 'note' | 'canvas' | 'schedule'

/** 传输由宿主实现并负责认证和权限检查。 */
export interface CliClient {
  invoke<T>(object: CliObject, action: string, input: unknown, signal?: AbortSignal): Promise<CliResult<T>>
}
