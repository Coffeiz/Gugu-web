import { CoreError } from '@gugu/core'

/** 解析旧 API 接受的正整数字符串文件 ID。 */
export function parseFileId(value: string): number {
  if (!/^\d+$/.test(value)) throw new CoreError('invalid_request', '文件 ID 无效')
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id < 1) throw new CoreError('invalid_request', '文件 ID 无效')
  return id
}
