import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { CoreError } from '../../contracts/index.js'

/** 在可信根下逐级创建目录，拒绝符号链接及越界路径。 */
export async function ensureSkillDirectory(dataRoot: string, directory: string) {
  const offset = relative(dataRoot, directory)
  if (!offset || isAbsolute(offset) || offset === '..' || offset.startsWith(`..${sep}`))
    throw new CoreError('invalid_request', '技能目录无效')
  let current = await realpath(dataRoot)
  for (const component of offset.split(sep)) {
    current = join(current, component)
    try { await mkdir(current, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(current) !== current)
      throw new CoreError('invalid_request', '技能目录无效')
  }
  return current
}
