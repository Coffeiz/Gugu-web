import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { normalizeOwnerId } from '../../../adapters/owner-context.js'
import { isPathWithin } from '../../../adapters/path-safety.js'

export type PreferenceTextKind = 'personality' | 'group-personality' | 'reply-style'

export interface PreferenceTextFiles {
  read(ownerId: string, kind: PreferenceTextKind): Promise<string | null>
  write(ownerId: string, kind: PreferenceTextKind, value: string | null): Promise<boolean>
}

const filenames: Record<PreferenceTextKind, string> = {
  personality: 'persona.md',
  'group-personality': 'group-persona.md',
  'reply-style': 'reply-style.md',
}

async function rejectSymlinkComponents(root: string, candidate: string, includeLeaf: boolean): Promise<void> {
  const relative = path.relative(root, candidate)
  if (!isPathWithin(root, candidate)) throw new Error('用户偏好文件路径超出存储根目录')
  let cursor = root
  const parts = relative.split(path.sep).filter(Boolean)
  const limit = includeLeaf ? parts.length : Math.max(0, parts.length - 1)
  for (const [index, part] of parts.slice(0, limit).entries()) {
    cursor = path.join(cursor, part)
    try {
      const info = await lstat(cursor)
      const isLeaf = includeLeaf && index === limit - 1
      if (info.isSymbolicLink() || (!isLeaf && !info.isDirectory())) throw new Error('用户偏好文件路径无效')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

export function createLocalPreferenceTextFiles(storageRoot: string): PreferenceTextFiles {
  const configuredRoot = path.resolve(storageRoot)

  async function paths(ownerId: string, kind: PreferenceTextKind, createParent: boolean) {
    const normalizedOwnerId = normalizeOwnerId(ownerId)
    await mkdir(configuredRoot, { recursive: true, mode: 0o700 })
    const root = await realpath(configuredRoot)
    const ownerRoot = path.resolve(root, normalizedOwnerId)
    const directory = path.join(ownerRoot, '.agent', 'prompt')
    const file = path.join(directory, filenames[kind])
    if (!isPathWithin(root, file)) throw new Error('用户偏好文件路径超出存储根目录')
    await rejectSymlinkComponents(root, directory, false)
    if (createParent) {
      for (const target of [ownerRoot, path.join(ownerRoot, '.agent'), directory]) {
        try {
          await mkdir(target, { mode: 0o700 })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
        const info = await lstat(target)
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('用户偏好目录路径无效')
        if (!isPathWithin(root, await realpath(target))) throw new Error('用户偏好目录超出存储根目录')
      }
    }
    await rejectSymlinkComponents(root, directory, false)
    return { root, file }
  }

  const read = async (ownerId: string, kind: PreferenceTextKind) => {
    const { root, file } = await paths(ownerId, kind, false)
    await rejectSymlinkComponents(root, file, true)
    try {
      return await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  return {
    read,
    async write(ownerId, kind, value) {
      const current = await read(ownerId, kind)
      if (current === value) return false
      const { root, file } = await paths(ownerId, kind, true)
      await rejectSymlinkComponents(root, file, true)
      if (value === null) {
        try { await rm(file) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        return true
      }
      const temporary = path.join(path.dirname(file), `.preference-${randomUUID()}.tmp`)
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(value, 'utf8')
        await handle.sync()
        await handle.close()
        await rename(temporary, file)
      } catch (error) {
        await handle.close().catch(() => undefined)
        await rm(temporary, { force: true }).catch(() => undefined)
        throw error
      }
      return true
    },
  }
}
