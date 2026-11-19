import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { CoreError } from '@gugu/core'
import { createLocalFileTree, localEntryKind, moveLocalEntry, removeLocalTree } from '@gugu/fs/node'
import type { FileDirectory } from '../../workspaces/files.js'

export interface TrashEntry {
  id: string
  directory: FileDirectory
  relativePath: string
  name: string
  kind: 'file' | 'directory'
  deletedAt: string
}

const itemId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function legacyTrashId(owner: string, legacyId: number) {
  const hash = createHash('sha256').update(`gugu-legacy-trash:${owner}:${legacyId}`).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

export function createDiskTrash(
  storage: string,
  resolveRoot: (owner: string, directory: FileDirectory) => Promise<string>,
) {
  const root = (owner: string) => `${owner}/.gugu-trash`
  function item(owner: string, id: string) {
    if (!itemId.test(id)) throw new CoreError('not_found', '回收项不存在')
    return `${root(owner)}/${id}`
  }
  async function readDescriptor(owner: string, id: string): Promise<TrashEntry | null> {
    const descriptor = await createLocalFileTree(storage, item(owner, id)).open('entry.json')
    if (!descriptor) return null
    try {
      if (descriptor.size > 32_768) throw new CoreError('storage_error', '回收项信息无效')
      const entry = JSON.parse(await descriptor.handle.readFile('utf8')) as TrashEntry
      if (entry.id !== id || !Number.isFinite(Date.parse(entry.deletedAt)))
        throw new CoreError('storage_error', '回收项信息无效')
      return entry
    } finally {
      await descriptor.handle.close()
    }
  }

  async function info(owner: string, id: string): Promise<TrashEntry | null> {
    const kind = await localEntryKind(storage, `${item(owner, id)}/payload`)
    if (!kind) return null
    const entry = await readDescriptor(owner, id)
    if (entry?.kind !== kind) throw new CoreError('storage_error', '回收项信息无效')
    return entry
  }

  async function writeDescriptor(tree: ReturnType<typeof createLocalFileTree>, entry: TrashEntry) {
    await tree.upload('entry.json', (async function* () {
      yield Buffer.from(JSON.stringify(entry))
    })(), new AbortController().signal)
  }

  async function store(owner: string, directory: FileDirectory, relativePath: string, source: string, deletedAt: string) {
    const kind = await localEntryKind(storage, source)
    if (!kind) return false
    const id = randomUUID()
    const key = item(owner, id)
    const tree = createLocalFileTree(storage, key)
    if (!await tree.ensureRoot()) return false
    const entry = { id, directory, relativePath, name: posix.basename(relativePath), kind, deletedAt } satisfies TrashEntry
    let moved = false
    try {
      await writeDescriptor(tree, entry)
      moved = await moveLocalEntry(storage, source, `${key}/payload`)
      return moved
    } finally {
      if (!moved) await removeLocalTree(storage, key)
    }
  }

  /** 导入时先写描述再搬正文；旧库写入应在切换窗口暂停。相同清单可从两步之间重试。 */
  async function importLegacy(owner: string, legacyId: number, directory: FileDirectory, relativePath: string, source: string, deletedAt: string) {
    const legacyRoot = createLocalFileTree(storage, `${owner}/trash`)
    const prefix = `${owner}/trash/`
    if (!Number.isSafeInteger(legacyId) || legacyId <= 0 || !source.startsWith(prefix))
      throw new CoreError('invalid_request', '旧回收项标识或路径无效')
    legacyRoot.storageKey(source.slice(prefix.length))
    createLocalFileTree(storage, await resolveRoot(owner, directory)).storageKey(relativePath)
    const timestamp = Date.parse(deletedAt)
    if (!Number.isFinite(timestamp)) throw new CoreError('invalid_request', '旧回收项删除时间无效')

    const id = legacyTrashId(owner, legacyId)
    const entry: TrashEntry = { id, directory, relativePath, name: posix.basename(relativePath), kind: 'file', deletedAt: new Date(timestamp).toISOString() }
    const key = item(owner, id)
    const tree = createLocalFileTree(storage, key)
    const matches = async () => JSON.stringify(await readDescriptor(owner, id)) === JSON.stringify(entry)
    if (await info(owner, id)) {
      if (await matches() && !await localEntryKind(storage, source)) return id
      throw new CoreError('conflict', '旧回收项与已导入内容冲突')
    }
    if (await localEntryKind(storage, source) !== 'file') throw new CoreError('not_found', '旧回收项文件不存在')
    if (!await tree.ensureRoot()) throw new CoreError('storage_error', '无法初始化回收目录')
    try { await writeDescriptor(tree, entry) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (!await matches()) throw new CoreError('conflict', '旧回收项与已导入内容冲突')
    }
    if (!await moveLocalEntry(storage, source, `${key}/payload`) && !await info(owner, id))
      throw new CoreError('not_found', '旧回收项文件不存在')
    return id
  }

  return {
    async list(owner: string) {
      const children = await createLocalFileTree(storage, root(owner)).list('')
      const entries: TrashEntry[] = []
      for (const child of children ?? []) {
        if (child.kind !== 'directory' || !itemId.test(child.name)) continue
        const entry = await info(owner, child.name)
        if (entry) entries.push(entry)
      }
      return entries.sort((left, right) => right.deletedAt.localeCompare(left.deletedAt))
    },
    store,
    importLegacy,
    async restore(owner: string, id: string) {
      const entry = await info(owner, id)
      if (!entry) throw new CoreError('not_found', '回收项不存在')
      const tree = createLocalFileTree(storage, await resolveRoot(owner, entry.directory))
      const destination = tree.storageKey(entry.relativePath)
      if (!await createLocalFileTree(storage, posix.dirname(destination)).ensureRoot()) return false
      const key = item(owner, id)
      const restored = await moveLocalEntry(storage, `${key}/payload`, destination)
      if (restored) await removeLocalTree(storage, key)
      return restored
    },
    async purge(owner: string, id: string) {
      const key = item(owner, id)
      const staging = `${root(owner)}/.gugu-purge-${id}`
      if (!await moveLocalEntry(storage, key, staging) && !await localEntryKind(storage, staging)) return false
      await removeLocalTree(storage, staging)
      return true
    },
  }
}
