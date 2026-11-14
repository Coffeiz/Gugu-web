import { CoreError } from '@gugu/core'

/** 验证 UUID 形式的文件 owner ID，并统一存为小写。 */
export function normalizeFileOwnerId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new CoreError('invalid_request', '用户标识无效')
  return value.toLowerCase()
}
