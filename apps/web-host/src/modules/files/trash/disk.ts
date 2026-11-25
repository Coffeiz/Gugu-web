import { randomUUID } from 'node:crypto'
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

  async function store(owner: string, directory: FileDirectory, relativePath: string, source: string, deletedAt: string, history?: { expected?: string; reverse?: string; trash: 'store' }) {
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
      moved = await moveLocalEntry(storage, source, `${key}/payload`, history)
      return moved ? entry : false
    } finally {
      if (!moved) await removeLocalTree(storage, key)
    }
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
    info,
    async restore(owner: string, id: string, expectedRoot?: string, history?: { expected?: string; reverse?: string; trash: 'restore' }) {
      const entry = await info(owner, id)
      if (!entry) throw new CoreError('not_found', '回收项不存在')
      const destinationRoot = await resolveRoot(owner, entry.directory)
      if (expectedRoot !== undefined && expectedRoot !== destinationRoot) throw new CoreError('conflict', '恢复目录授权已变化')
      const tree = createLocalFileTree(storage, destinationRoot)
      const destination = tree.path(entry.relativePath)
      if (!await createLocalFileTree(storage, posix.dirname(destination)).ensureRoot()) return false
      const key = item(owner, id)
      const restored = await moveLocalEntry(storage, `${key}/payload`, destination, history)
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
