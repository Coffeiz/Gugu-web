import { constants } from 'node:fs'
import { link, lstat, open, realpath, unlink } from 'node:fs/promises'
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

async function checkedFilePath(rootPath: string, relativePath: string): Promise<string | null> {
  const segments = relativePath.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0')))
    throw new UnsafeLocalPathError()
  try {
    const root = await realpath(rootPath)
    let target = root
    for (const segment of segments) {
      target = path.join(target, segment)
      if (!within(root, target) || (await lstat(target)).isSymbolicLink()) throw new UnsafeLocalPathError()
    }
    return target
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
}

/** 在授权根内暂存普通文件，目标已存在时拒绝覆盖。 */
export async function stageLocalFile(root: string, relativePath: string, journalId: string) {
  if (!/^[0-9a-f-]{36}$/.test(journalId)) throw new UnsafeLocalPathError()
  const original = await checkedFilePath(root, relativePath)
  if (!original) return null
  const info = await lstat(original)
  if (!info.isFile()) throw new UnsafeLocalPathError()
  const stagedPath = `${original}.gugu-purge-${journalId}`
  await link(original, stagedPath)
  try { await unlink(original) } catch (error) { await unlink(stagedPath).catch(() => undefined); throw error }
  return { size: info.size, stagedPath }
}

/** 恢复或删除暂存文件；原位置已有不同文件时保留两者并报错。 */
export async function finishStagedLocalFile(root: string, relativePath: string, journalId: string, restore: boolean): Promise<void> {
  if (!/^[0-9a-f-]{36}$/.test(journalId)) throw new UnsafeLocalPathError()
  const suffix = `.gugu-purge-${journalId}`
  const staged = await checkedFilePath(root, `${relativePath}${suffix}`)
  if (!staged) return
  if (!(await lstat(staged)).isFile()) throw new UnsafeLocalPathError()
  if (restore) {
    const original = staged.slice(0, -suffix.length)
    try { await link(staged, original) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const [source, target] = await Promise.all([lstat(staged), lstat(original)])
      if (!source.isFile() || !target.isFile() || source.dev !== target.dev || source.ino !== target.ino) throw error
    }
  }
  await unlink(staged)
}
