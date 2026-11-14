import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'

/** 不可信路径不能用于访问授权根之外的内容。 */
export class UnsafeLocalPathError extends Error {}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/** 在可信授权根中打开相对路径；调用方负责校验身份并关闭返回的句柄。 */
export async function openLocalFile(rootPath: string, relativePath: string) {
  const segments = relativePath.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0'))) throw new UnsafeLocalPathError()
  try {
    const root = await realpath(rootPath)
    let target = root
    for (const segment of segments) {
      target = path.resolve(target, segment)
      if (!within(root, target) || (await lstat(target)).isSymbolicLink()) throw new UnsafeLocalPathError()
    }
    const canonical = await realpath(target)
    if (!within(root, canonical)) throw new UnsafeLocalPathError()
    const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw new UnsafeLocalPathError()
      return { handle, size: info.size }
    } catch (error) {
      await handle.close()
      throw error
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') return null
    throw error
  }
}
