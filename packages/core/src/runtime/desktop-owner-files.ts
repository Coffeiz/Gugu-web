import { lstat, mkdir, readFile, readdir, rename, rmdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dataContext } from '../contracts/index.js'

async function inspect(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
}

async function ensureDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (!(await lstat(path)).isDirectory()) throw new Error('桌面账号文件目录无效')
}

/** 启动本地账号时移动旧目录。同名内容留存，后续启动只使用账号路径。 */
export async function prepareDesktopOwnerFiles(root: string, databaseDirectory: string, rawOwner: string) {
  const owner = dataContext(rawOwner).ownerId
  const account = join(root, owner)
  await ensureDirectory(root)
  await ensureDirectory(account)
  const marker = join(root, '.owner-layout-v1')
  const state = await inspect(marker)
  if (state) {
    if (!state.isFile()) throw new Error('桌面目录迁移标记无效')
    return account
  }
  const claim = join(root, '.owner-layout-v1.pending')
  await writeFile(claim, owner + '\n', { flag: 'wx', mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  if ((await inspect(marker))?.isFile()) return account
  if (!(await lstat(claim)).isFile() || (await readFile(claim, 'utf8')).trim() !== owner)
    throw new Error('旧桌面目录正在由另一个本地账号迁移')
  for (const path of [join(root, '.agent'), join(root, 'personal'), join(root, 'project'),
    join(account, '.agent'), join(account, 'personal'), join(account, 'project'), join(account, 'projects')]) {
    const info = await inspect(path)
    if (info && !info.isDirectory()) throw new Error('桌面迁移目录无效')
  }
  if (resolve(root) !== resolve(databaseDirectory)) {
    const oldOwner = join(databaseDirectory, owner)
    const info = await inspect(oldOwner)
    if (info && !info.isDirectory()) throw new Error('旧桌面账号目录无效')
    const agent = await inspect(join(oldOwner, '.agent'))
    if (agent && !agent.isDirectory()) throw new Error('旧桌面 Agent 目录无效')
    await move(join(oldOwner, '.agent'), join(account, '.agent'))
  }
  await move(join(root, '.agent'), join(account, '.agent'))
  await move(join(root, 'personal'), join(account, 'personal'))
  await move(join(root, 'project'), join(account, 'projects'))
  await move(join(account, 'project'), join(account, 'projects'))
  await rename(claim, marker)
  return account

  async function move(source: string, destination: string) {
    const sourceInfo = await inspect(source)
    if (!sourceInfo) return
    const destinationInfo = await inspect(destination)
    if (!destinationInfo) {
      await rename(source, destination)
      return
    }
    if (sourceInfo.isDirectory() && destinationInfo.isDirectory()) {
      for (const name of await readdir(source)) await move(join(source, name), join(destination, name))
      await rmdir(source)
      return
    }
    const conflicts = join(account, '.migration-conflicts')
    await ensureDirectory(conflicts)
    const conflict = join(conflicts, randomUUID())
    await ensureDirectory(conflict)
    await rename(source, join(conflict, basename(source)))
  }
}
