import { CoreError } from '../contracts/index.js'

const reservedRoots = new Set(['workspace', 'shell', '个人文件', '项目文件', '思维', '素材板'])
const invalidName = /[\\/:*?"<>|]/

/** 校验并规范化 Workspace 目录显示名称。 */
export function normalizeWorkspaceDirectoryName(value: string): string {
  const name = value.trim()
  if (!name) throw new CoreError('invalid_request', '名称不能为空')
  if (Array.from(name).length > 200) throw new CoreError('invalid_request', '名称长度不能超过 200 个字符')
  if (invalidName.test(name)) throw new CoreError('invalid_request', '名称不能包含以下字符：\\ / : * ? " < > |')
  return name
}

/** 避免用户目录与系统根目录或默认目录重名。 */
export function validateWorkspaceDirectoryName(name: string): void {
  const safeName = name.replace(invalidNameGlobal, '_')
  if (reservedRoots.has(safeName) || name.toLowerCase() === 'default')
    throw new CoreError('conflict', 'Workspace 名称与系统目录冲突')
}
const invalidNameGlobal = /[\\/:*?"<>|]/g
