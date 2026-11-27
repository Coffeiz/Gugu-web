import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { CoreError } from '../../contracts/index.js'

/** 对技能目录和文件内容计算稳定摘要，用于撤销前检测用户修改。 */
export async function skillPackageDigest(root: string) {
  const hash = createHash('sha256')
  let count = 0, total = 0
  const conflict = (): never => { throw new CoreError('conflict', '技能文件已变化，无法撤销或重做') }
  async function visit(path: string, name: string): Promise<void> {
    if (++count > 1000) conflict()
    const info = await lstat(path)
    if (info.isSymbolicLink()) conflict()
    if (info.isDirectory()) {
      hash.update(JSON.stringify([name, 'directory']))
      for (const child of (await readdir(path)).sort()) await visit(join(path, child), `${name}/${child}`)
    } else if (info.isFile()) {
      total += info.size
      if (total > 32 * 1024 * 1024) conflict()
      const content = await readFile(path)
      if (content.length !== info.size) conflict()
      hash.update(JSON.stringify([name, 'file', content.length])).update(content)
    } else conflict()
  }
  await visit(root, '')
  return hash.digest('hex')
}
