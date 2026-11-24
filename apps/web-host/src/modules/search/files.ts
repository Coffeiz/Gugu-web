import { CoreError } from '@gugu/core'
import { createWorkspaceFileReads } from '../workspaces/files.js'
import type { ResolvedObjectPath } from '@gugu/core/agent'
import type { GlobalSearchQuery, GlobalSearchSource } from '@gugu/core'
import { createLocalFileTree, UnsafeLocalPathError } from '@gugu/fs/node'
import type { Pool } from 'pg'
import { normalizeOwnerId } from '../../shared/owner-context.js'
import { projectFileStorageKey } from '../files/paths.js'
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
  link?: string
  path_file: { directoryId: SearchRoot['directoryId']; relativePath: string; directoryName: string; location: ResolvedObjectPath }
}

export function createDiskFileSearchSources(pool: Pick<Pool, 'query'>, storageRoot: string) {
  // Core 为每次搜索建立单独的查询快照，文件和文件夹可以共用一次目录遍历。
  const files = createWorkspaceFileReads(pool, storageRoot)
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
    const browse = terms.length === 0
    const requested = query.types ?? ['file', 'folder']
    let remaining = 10_000
    const complete = () => (['file', 'folder'] as const)
      .every(type => !requested.includes(type) || found[type].length >= query.perType)
    const searchRoots = await roots(owner)
    function add(kind: 'file' | 'folder', candidate: Ranked) {
      const candidates = found[kind]
      if (kind === 'folder') {
        const previous = candidates.findIndex(entry => entry.item.path_file.location.value === candidate.item.path_file.location.value)
        if (previous >= 0) {
          if (compare(candidate, candidates[previous]!) >= 0) return
          candidates.splice(previous, 1)
        }
      }
      candidates.push(candidate)
      candidates.sort(compare)
      if (candidates.length > query.perType) candidates.pop()
    }

    if (requested.includes('folder') && !browse) {
      const { rows: links } = await pool.query<{ project_id: number; directory_id: number }>(`
        SELECT DISTINCT l.project_id,l.directory_id FROM project_workspace_directories l
        JOIN workspaces w ON w.directory_id=l.directory_id AND w.user_id=l.user_id AND w.kind='directory' AND w.enabled
        WHERE l.user_id=$1`, [owner])
      const directories = new Map(searchRoots.map(root => [root.directoryId, root]))
      for (const project of searchRoots) {
        if (typeof project.directoryId !== 'string' || project.directoryId === 'personal') continue
        const projectId = Number(project.directoryId.slice(8))
        const linked = links.filter(link => link.project_id === projectId)
        const targets = linked.length ? linked.map(link => directories.get(link.directory_id)) : [project]
        const title = project.name.normalize('NFC').toLowerCase()
        for (const target of targets) {
          signal?.throwIfAborted()
          if (!target) continue
          const sandboxPath = sandboxTarget(target.storageKey)
          const hits = terms.filter(term => term.startsWith('/') ? sandboxPath === term : title.includes(term)).length
          if (query.mode === 'AND' ? hits !== terms.length : hits === 0) continue
          const directory = typeof target.directoryId === 'number' ? target.directoryId : { projectId }
          try {
            const reference = await files.reference(owner, directory, '', undefined, 'folder')
            if (reference.location.value !== sandboxPath) continue
            add('folder', { item: {
              id: JSON.stringify([target.directoryId, '']), title: project.name, subtitle: target.name,
              link: 'gugu://open-object/folder/' + reference.id,
              path_file: { directoryId: target.directoryId, directoryName: target.name, relativePath: '', location: reference.location },
            }, hits, rank: title === terms[0] ? 0 : 1 })
          } catch (error) {
            if (!(error instanceof CoreError && error.code === 'not_found')) throw error
          }
        }
      }
    }
    rootsLoop: for (const root of searchRoots) {
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
          if (browse && remaining-- <= 0) break rootsLoop
          const kind = entry.kind === 'file' ? 'file' : 'folder'
          if (kind === 'folder') directories.push(entry.relativePath)
          if (query.types && !query.types.includes(kind)) continue
          const title = entry.name.normalize('NFC').toLowerCase()
          const path = entry.relativePath.normalize('NFC').toLowerCase()
          const sandboxPath = `${sandboxRoot}/${entry.relativePath}`
          const hits = terms.filter(term => term.startsWith('/') ? sandboxPath === term : path.includes(term)).length
          if (!browse && (query.mode === 'AND' ? hits !== terms.length : hits === 0)) continue
          const rank = browse ? 3 : title === terms[0] ? 0 : title.startsWith(terms[0]!) ? 1 : title.includes(terms[0]!) ? 2 : 3
          const candidate = {
            item: {
              id: JSON.stringify([root.directoryId, entry.relativePath]),
              title: entry.name, subtitle: [root.name, directory].filter(Boolean).join(' · '),
              path_file: { directoryId: root.directoryId, directoryName: root.name, relativePath: entry.relativePath, location: { kind: 'sandbox' as const, value: sandboxPath } },
            },
            hits, rank,
          }
          add(kind, candidate)
          if (browse && complete()) break rootsLoop
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
      const items = (await pending)[type]
      if (type === 'file') return items.map(item => ({ ...item }))
      return Promise.all(items.map(async item => {
        signal?.throwIfAborted()
        if (item.link) return { ...item }
        const { directoryId, relativePath } = item.path_file
        const directory = typeof directoryId === 'string' && directoryId !== 'personal'
          ? { projectId: Number(directoryId.slice(8)) } : directoryId
        try {
          const reference = await files.reference(owner, directory, relativePath, undefined, 'folder')
          return { ...item, link: 'gugu://open-object/folder/' + reference.id }
        } catch (error) {
          if (error instanceof CoreError && error.code === 'not_found') return { ...item }
          throw error
        }
      }))
    },
  } satisfies GlobalSearchSource))
}
