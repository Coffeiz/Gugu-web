import { CoreError } from '../contracts/index.js'

/** 根与路径授权由 Host 完成；open 必须绑定可信根及安全文件打开实现。 */
export async function openAuthorizedRelativeFile<Handle>(
  relativePath: string,
  open: (relativePath: string) => Promise<{ handle: Handle; size: number } | null>,
  isUnsafePath: (error: unknown) => boolean,
) {
  if (relativePath.split('/').some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0')))
    throw new CoreError('not_found', '文件不存在')
  try { return await open(relativePath) }
  catch (error) {
    if (isUnsafePath(error)) throw new CoreError('not_found', '文件不存在')
    throw error
  }
}
