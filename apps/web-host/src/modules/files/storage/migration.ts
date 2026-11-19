import { basename, dirname } from 'node:path'
import { CoreError } from '@gugu/core'
import { createLocalFileTree, listLocalDirectory, moveLocalEntry, openAnchoredLocalFile, UnsafeLocalPathError } from '@gugu/fs/node'
import { normalizeOwnerId } from '../../../shared/owner-context.js'
import { personalFileStorageKey } from '../../workspaces/roots.js'

export interface FileMigrationEntry {
  id: number
  storageKey: string
  restoreKey: string | null
  displayName: string
  deletedAt: string | null
}

function scope(entry: FileMigrationEntry, owner: string): void {
  const parts = (key: string) => key.split('/')
  const valid = (key: string) => {
    const segments = parts(key)
    return segments.length >= 3 && segments[0] === owner && !segments.some(segment =>
      !segment || segment === '.' || segment === '..' || segment.startsWith('.gugu-') || /[\\\0]/.test(segment))
  }
  const activeSpaces = ['个人文件', '项目文件', 'workspace', '思维', '素材板']
  if (!Number.isSafeInteger(entry.id) || entry.id <= 0 || typeof entry.displayName !== 'string'
    || typeof entry.storageKey !== 'string' || !valid(entry.storageKey))
    throw new CoreError('invalid_request', '文件迁移记录无效')
  const space = parts(entry.storageKey)[1]!
  if (entry.deletedAt === null && entry.restoreKey === null && activeSpaces.includes(space)) return
  if (typeof entry.deletedAt === 'string' && Number.isFinite(Date.parse(entry.deletedAt)) && space === 'trash'
    && typeof entry.restoreKey === 'string' && valid(entry.restoreKey)
    && activeSpaces.includes(parts(entry.restoreKey)[1]!)) return
  throw new CoreError('invalid_request', '文件迁移记录的原位置或回收位置无效')
}

type StoredFile = { entry: FileMigrationEntry; device: string; inode: string; birthtimeNs: string }

/** 目录由 Host 传入。索引只用于有明确迁移清单的文件，身份与路径均从已迁移数据验证。 */
export function createFileMigrationStorage(root: string) {
  const catalog = (owner: string) => createLocalFileTree(root, `${owner}/.gugu-file-migration`)
  const metadataName = (id: number) => `${id}.json`

  async function open(key: string) {
    try { return await openAnchoredLocalFile(root, key) }
    catch (error) {
      if (error instanceof UnsafeLocalPathError) return null
      throw error
    }
  }

  async function sameFile(stat: StoredFile, candidate: string) {
    const opened = await open(candidate)
    if (!opened) return null
    let keep = false
    try {
      const { dev, ino, birthtimeNs } = await opened.handle.stat({ bigint: true })
      keep = stat.device === dev.toString() && stat.inode === ino.toString() && stat.birthtimeNs === birthtimeNs.toString()
      return keep ? opened : null
    } finally {
      if (!keep) await opened.handle.close()
    }
  }

  async function record(owner: string, id: number): Promise<StoredFile | null> {
    if (!Number.isSafeInteger(id) || id <= 0) return null
    const source = await catalog(owner).open(metadataName(id))
    if (!source) return null
    try {
      if (source.size > 32_768) throw new CoreError('storage_error', '文件迁移索引无效')
      const data = JSON.parse(await source.handle.readFile('utf8')) as StoredFile
      if (!data.entry || data.entry.id !== id || !/^\d+$/.test(data.device) || !/^\d+$/.test(data.inode)
        || typeof data.birthtimeNs !== 'string' || !/^\d+$/.test(data.birthtimeNs))
        throw new CoreError('storage_error', '文件迁移索引无效')
      scope(data.entry, owner)
      return data
    } finally {
      await source.handle.close()
    }
  }

  return {
    async install(rawOwner: string, entry: FileMigrationEntry) {
      const owner = normalizeOwnerId(rawOwner)
      scope(entry, owner)
      const existing = await record(owner, entry.id)
      if (existing) {
        if (JSON.stringify(existing.entry) !== JSON.stringify(entry))
          throw new CoreError('conflict', '旧文件标识对应多个目标')
        const source = await sameFile(existing, entry.storageKey)
          ?? (entry.restoreKey ? await sameFile(existing, entry.restoreKey) : null)
        if (!source) throw new CoreError('conflict', '文件内容与已安装的迁移记录不一致')
        await source.handle.close()
        return
      }
      const source = await open(entry.storageKey)
      if (!source) throw new CoreError('not_found', '迁移文件不存在')
      let data: StoredFile
      try {
        const { dev, ino, birthtimeNs } = await source.handle.stat({ bigint: true })
        data = { entry, device: dev.toString(), inode: ino.toString(), birthtimeNs: birthtimeNs.toString() }
      } finally {
        await source.handle.close()
      }
      const index = catalog(owner)
      if (!await index.ensureRoot()) throw new CoreError('storage_error', '无法初始化文件迁移索引')
      try {
        await index.upload(metadataName(entry.id), (async function* () {
          yield Buffer.from(JSON.stringify(data))
        })(), new AbortController().signal)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const existing = await record(owner, entry.id)
        if (JSON.stringify(existing) !== JSON.stringify(data)) throw new CoreError('conflict', '旧文件标识对应多个目标')
      }
    },
    async openReference(rawOwner: string, id: number) {
      const data = await record(normalizeOwnerId(rawOwner), id)
      if (!data) return null
      const key = data.entry.restoreKey ?? data.entry.storageKey
      const source = await sameFile(data, key)
      return source ? { ...source, fileName: basename(key), entry: data.entry } : null
    },
    /** undefined 表示仍走旧服务；已迁移的 ID 在回收或永久删除后返回 null。 */
    async openPersonalReference(rawOwner: string, id: number) {
      const owner = normalizeOwnerId(rawOwner)
      const data = await record(owner, id)
      const personal = personalFileStorageKey(owner)
      const key = data?.entry.restoreKey ?? data?.entry.storageKey
      if (!data || !key?.startsWith(`${personal}/`)) return undefined
      const opened = await sameFile(data, key)
      if (opened) return { ...opened, relativePath: key.slice(personal.length + 1) }

      // 旧路径可能已被 Shell 移动或由其他文件占用。只在归属已知的个人根内找同一实体。
      if (data.birthtimeNs === '0') return null
      const directories = [personal]
      while (directories.length) {
        const directory = directories.pop()!
        let entries
        try { entries = await listLocalDirectory(root, directory) }
        catch (error) {
          if (!(error instanceof UnsafeLocalPathError)) throw error
          continue
        }
        for (const entry of entries ?? []) {
          const candidate = `${directory}/${entry.name}`
          if (entry.kind === 'directory') directories.push(candidate)
          else if (candidate !== key) {
            const source = await sameFile(data, candidate)
            if (source) return { ...source, relativePath: candidate.slice(personal.length + 1) }
          }
        }
      }
      return null
    },
    async restore(rawOwner: string, id: number) {
      const owner = normalizeOwnerId(rawOwner)
      const data = await record(owner, id)
      if (!data?.entry.restoreKey) throw new CoreError('not_found', '未找到迁移的回收项')
      const { storageKey, restoreKey } = data.entry
      const existing = await sameFile(data, restoreKey)
      if (existing) {
        await existing.handle.close()
        return
      }
      const original = await sameFile(data, storageKey)
      if (!original) {
        const concurrentResult = await sameFile(data, restoreKey)
        if (!concurrentResult) throw new CoreError('not_found', '回收项内容已变化')
        await concurrentResult.handle.close()
        return
      }
      await original.handle.close()
      const parent = createLocalFileTree(root, dirname(restoreKey))
      if (!await parent.ensureRoot()) throw new CoreError('storage_error', '无法创建还原目录')
      try {
        await moveLocalEntry(root, storageKey, restoreKey)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error
        throw new CoreError('conflict', '还原位置已存在同名文件')
      }
      const concurrentResult = await sameFile(data, restoreKey)
      if (!concurrentResult) throw new CoreError('not_found', '回收项内容已变化')
      await concurrentResult.handle.close()
    },
  }
}
