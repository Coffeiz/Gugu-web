import { CoreError } from '@gugu/core'

/** 验证 UUID 形式的文件 owner ID，并统一存为小写。 */
export function normalizeFileOwnerId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new CoreError('invalid_request', '用户标识无效')
  return value.toLowerCase()
}

/** 普通存储使用 UUID 路径，旧版数据导入使用同一用户的无连字符目录。 */
export function isOwnedFileStorageKey(ownerId: string, key: string): boolean {
  return key.startsWith(`${ownerId}/`)
    || key.startsWith(`${ownerId.replaceAll('-', '')}/.data-portability/imported/`)
}
