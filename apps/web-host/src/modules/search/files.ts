import type { GlobalSearchQuery, GlobalSearchSource } from '@gugu/core'
import { createLocalFileTree, UnsafeLocalPathError } from '@gugu/fs/node'
import type { Pool } from 'pg'
import { normalizeOwnerId } from '../../shared/owner-context.js'
import { projectFileStorageKey } from '../files/folders/paths.js'
import { personalFileStorageKey, sandboxTarget, workspaceDirectoryStorageKey } from '../workspaces/roots.js'

interface SearchRoot {
  directoryId: number | 'personal' | `project:${number}`
  name: string
  storageKey: string
}

interface PathHit {
  id: string
  title: string
  subtitle: string
  path_file: { directoryId: SearchRoot['directoryId']; relativePath: string; directoryName: string; sandboxPath: string }
}

export function createDiskFileSearchSources(pool: Pick<Pool, 'query'>, storageRoot: string) {
  // Core 为每次搜索建立单独的查询快照，文件和文件夹可以共用一次目录遍历。
  const searches = new WeakMap<GlobalSearchQuery, Map<string, Promise<Record<'file' | 'folder', PathHit[]>>>>()

  async function roots(owner: string): Promise<SearchRoot[]> {
    const [projects, workspaces] = await Promise.all([
      pool.query<{ id: number; name: string; start_date: unknown; created_at: unknown }>(
        'SELECT id,name,start_date,created_at FROM projects WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id', [owner]),
      pool.query<{ id: number; name: string; directory_name: string }>(
        'SELECT id,name,directory_name FROM workspace_directories WHERE user_id=$1 AND deleted_at IS NULL ORDER BY id', [owner]),
    ])
    return [
      { directoryId: 'personal', name: '个人文件', storageKey: personalFileStorageKey(owner) },
      ...projects.rows.map((row): SearchRoot => ({
        directoryId: `project:${row.id}`, name: row.name,
        storageKey: projectFileStorageKey(owner, row.id, row.name, row.start_date, row.created_at),
      })),
      ...workspaces.rows.map((row): SearchRoot => ({
        directoryId: row.id, name: row.name, storageKey: workspaceDirectoryStorageKey(owner, row.directory_name),
      })),
    ]
  }

  async function scan(owner: string, query: GlobalSearchQuery, signal?: AbortSignal) {
    type Ranked = { item: PathHit; hits: number; rank: number }
    const found: Record<'file' | 'folder', Ranked[]> = { file: [], folder: [] }
    const terms = query.queries.map(term => term.startsWith('/') ? term : term.normalize('NFC').toLowerCase())
    const compare = (left: Ranked, right: Ranked) =>
      right.hits - left.hits || left.rank - right.rank || left.item.title.localeCompare(right.item.title)
    if (!terms.length) return { file: [], folder: [] }
    for (const root of await roots(owner)) {
      const tree = createLocalFileTree(storageRoot, root.storageKey)
      const sandboxRoot = sandboxTarget(root.storageKey)
      const directories = ['']
      while (directories.length) {
        signal?.throwIfAborted()
        const directory = directories.pop()!
        let entries
        try { entries = await tree.list(directory) }
        catch (error) {
          if (!(error instanceof UnsafeLocalPathError)) throw error
          continue
        }
        for (const entry of entries ?? []) {
          const kind = entry.kind === 'file' ? 'file' : 'folder'
          if (kind === 'folder') directories.push(entry.relativePath)
          if (query.types && !query.types.includes(kind)) continue
          const title = entry.name.normalize('NFC').toLowerCase()
          const path = entry.relativePath.normalize('NFC').toLowerCase()
          const sandboxPath = `${sandboxRoot}/${entry.relativePath}`
          const hits = terms.filter(term => term.startsWith('/') ? sandboxPath === term : path.includes(term)).length
          if (query.mode === 'AND' ? hits !== terms.length : hits === 0) continue
          const rank = title === terms[0] ? 0 : title.startsWith(terms[0]!) ? 1 : title.includes(terms[0]!) ? 2 : 3
          const candidates = found[kind]
          const candidate = {
            item: {
              id: JSON.stringify([root.directoryId, entry.relativePath]),
              title: entry.name, subtitle: [root.name, directory].filter(Boolean).join(' · '),
              path_file: { directoryId: root.directoryId, directoryName: root.name, relativePath: entry.relativePath, sandboxPath },
            },
            hits, rank,
          }
          if (candidates.length === query.perType && compare(candidate, candidates.at(-1)!) >= 0) continue
          candidates.push(candidate)
          candidates.sort(compare)
          if (candidates.length > query.perType) candidates.pop()
        }
      }
    }
    return { file: found.file.map(result => result.item), folder: found.folder.map(result => result.item) }
  }

  return (['file', 'folder'] as const).map(type => ({
    type, label: type === 'file' ? '文件' : '文件夹',
    async search(rawOwner: string, query: GlobalSearchQuery, signal?: AbortSignal) {
      const owner = normalizeOwnerId(rawOwner)
      let byOwner = searches.get(query)
      if (!byOwner) { byOwner = new Map(); searches.set(query, byOwner) }
      const pending = byOwner.get(owner) ?? scan(owner, query, signal)
      byOwner.set(owner, pending)
      return (await pending)[type].map(item => ({ ...item }))
    },
  } satisfies GlobalSearchSource))
}
