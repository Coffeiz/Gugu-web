import { CoreError, dataContext } from '@gugu/core'

/** 规范化由 Host 传入的 owner ID，并统一映射为 API 输入错误。 */
export function normalizeOwnerId(ownerId: string): string {
  try {
    return dataContext(ownerId).ownerId
  } catch {
    throw new CoreError('invalid_request', '用户 ID 无效')
  }
}
