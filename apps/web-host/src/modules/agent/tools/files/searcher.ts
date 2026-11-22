import { extname } from 'node:path'
import { CoreError } from '@gugu/core'
import type { Pool } from 'pg'
import { createSearcherReferenceSearch, createSearcherReferenceShell, type RunIdentity } from '@gugu/core/agent'
import { createOwnedTextReader } from '@gugu/core/tools'
import { isOwnedFileStorageKey } from '../../../files/store.js'
import { createWorkspaceFileReads } from '../../../workspaces/files.js'
import { parseWorkspaceFileReference } from '../../context/references.js'
import { createWebAgentFileReadPort, webAgentFileTextType } from './read.js'

function fileReference(value: unknown) {
  if (!value || typeof value !== 'object' || !('type' in value) || !['file', 'folder'].includes(String(value.type)) || !('id' in value)) return null
  const raw = value.id
  const workspace = value.type === 'file' ? parseWorkspaceFileReference(raw) : null
  if (workspace) return { ref: workspace.key, workspace }
  const id = typeof raw === 'string' && /^\s*\+?\d+\s*$/u.test(raw) ? Number(raw) : raw
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || id > 2147483647) return null
  return value.type === 'folder' ? { ref: `folder:${id}`, folderId: id } : { ref: String(id), id }
}

export function createWebSearcherFileAccess(pool: Pick<Pool, 'query'>, storageRoot: string) {
  const workspaceFiles = createWorkspaceFileReads(pool, storageRoot)
  const workspacePrefix = 'searcher-workspace-ref:'
  async function listed(parent: RunIdentity, refs: readonly string[], signal: AbortSignal, fileId?: number, expandFolders = true, query = '') {
    signal.throwIfAborted()
    if (!refs.length) return []
    const { rows: [row] } = await pool.query<{ references_json: unknown }>(`
      SELECT m.references_json FROM agent_run_dispatch d
      JOIN conversation_sessions s ON s.id=d.session_id AND s.user_id=d.user_id
      JOIN conversation_messages m ON m.id=d.message_id AND m.session_id=s.id AND m.role='user'
      WHERE d.user_id=$1 AND d.session_id=$2 AND d.run_id=$3 AND s.source='web' AND NOT d.cancel_requested`,
    [parent.ownerId, parent.sessionId, parent.runId])
    if (!Array.isArray(row?.references_json)) return []
    const selected = new Set(refs)
    const port = createWebAgentFileReadPort(pool, storageRoot, { identity: parent })
    const results = new Map<string, { ref: string; label: string; folder?: true; workspace?: NonNullable<ReturnType<typeof parseWorkspaceFileReference>> }>()
    for (const raw of row.references_json.slice(0, 6)) {
      const entry = fileReference(raw)
      if (!entry || !selected.has(entry.ref) || results.has(entry.ref)) continue
      if (entry.folderId !== undefined) {
        const folder = await pool.query('SELECT 1 FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',
          [entry.folderId, parent.ownerId])
        if (!folder.rowCount) continue
        results.set(entry.ref, { ref: entry.ref, label: '', folder: true })
        if (!expandFolders) continue
        const files = await pool.query<{ id: number; display_name: string; ext: string; storage_key: string }>(`
          WITH RECURSIVE delegated AS (
            SELECT id,project_id,workspace_directory_id FROM folders WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
            UNION
            SELECT f.id,f.project_id,f.workspace_directory_id FROM folders f JOIN delegated d ON f.parent_id=d.id
            WHERE f.user_id=$2 AND f.deleted_at IS NULL AND f.project_id IS NOT DISTINCT FROM d.project_id
              AND f.workspace_directory_id IS NOT DISTINCT FROM d.workspace_directory_id
          )
          SELECT f.id,f.display_name,f.ext,f.storage_key FROM files f JOIN delegated d ON f.folder_id=d.id
          WHERE f.user_id=$2 AND f.deleted_at IS NULL AND f.project_id IS NOT DISTINCT FROM d.project_id
            AND f.workspace_directory_id IS NOT DISTINCT FROM d.workspace_directory_id
            AND ($3::integer IS NULL OR f.id=$3)
            AND ($4::text='' OR strpos(lower(f.display_name || '.' || f.ext), lower($4))>0) ORDER BY f.id LIMIT 100`,
        [entry.folderId, parent.ownerId, fileId ?? null, query])
        for (const row of files.rows) {
          signal.throwIfAborted()
          if (isOwnedFileStorageKey(parent.ownerId, row.storage_key))
            results.set(String(row.id), { ref: String(row.id), label: `${row.display_name}.${row.ext}` })
        }
      } else if (entry.workspace) {
        const { directory, relativePath, identity } = entry.workspace
        try {
          const file = await workspaceFiles.reference(parent.ownerId, directory, relativePath, identity)
          results.set(entry.ref, { ref: entry.ref, label: file.label, workspace: entry.workspace })
        } catch (error) {
          if (!(error instanceof CoreError) || error.code !== 'not_found') throw error
        }
      } else if (entry.id !== undefined) {
        const file = await port.resolveOwnedFile(parent, entry.id, signal)
        if (file) results.set(entry.ref, { ref: entry.ref, label: file.name })
      }
      signal.throwIfAborted()
    }
    return [...results.values()]
  }
  return {
    async authorize(parent: RunIdentity, refs: readonly string[]) {
      const allowed = new Set((await listed(parent, refs, new AbortController().signal, undefined, false)).map(file => file.ref))
      return refs.every(ref => allowed.has(ref))
    },
    tools(parent: RunIdentity, child: RunIdentity, refs: readonly string[],
      authorizeShell: (signal: AbortSignal) => Promise<boolean>) {
      if (!refs.length) return []
      const port = createWebAgentFileReadPort(pool, storageRoot, { identity: child })
      const scope = new Set(refs)
      const search = createSearcherReferenceSearch(async (signal, query) => (await listed(parent, refs, signal, undefined, true, query)).filter(item => !item.folder).map(({ ref, label }) => ({ ref, label })))
      const reader = createOwnedTextReader({
        async openFile(root, path) {
          if (!path.startsWith(workspacePrefix)) return port.openFile(root, path)
          const ref = path.slice(workspacePrefix.length)
          if (!scope.has(ref)) return null
          const [entry] = await listed(parent, [ref], new AbortController().signal)
          if (!entry?.workspace) return null
          const { directory, relativePath, identity } = entry.workspace
          try { return await workspaceFiles.open(parent.ownerId, directory, relativePath, identity) }
          catch (error) {
            if (error instanceof CoreError && error.code === 'not_found') return null
            throw error
          }
        },
        async resolveFilePath(identity, ref, signal) {
          if (identity.ownerId !== child.ownerId || identity.sessionId !== child.sessionId || identity.runId !== child.runId || !scope.has(ref)) return null
          const [entry] = await listed(parent, [ref], signal)
          if (!entry?.workspace) return null
          return { name: entry.label, root: storageRoot, relativePath: workspacePrefix + ref,
            ...webAgentFileTextType(extname(entry.label).slice(1)) }
        },
        async resolveOwnedFile(identity, id, signal) {
          const ref = String(id)
          if (!Number.isInteger(id) || id < 1 || id > 2147483647
            || !(await listed(parent, refs, signal, id)).some(entry => entry.ref === ref)) return null
          return port.resolveOwnedFile(identity, id, signal)
        },
      })
      const shell = createSearcherReferenceShell(async (ref, toolScope, maxOutputChars) => {
        if (!await authorizeShell(toolScope.signal))
          return { kind: "completed", successful: false, executed: false, mutated: false, value: { error: "Shell 权限已失效" } }
        const result = await reader(ref.length === 24 ? { file: ref } : { file_id: Number(ref) }, toolScope)
        if (result.kind !== "completed" || !result.successful) return result
        const value = result.value as { content: string; name: string }
        return { ...result, executed: true, value: { stdout: value.content.slice(0, maxOutputChars),
          name: value.name, truncated: value.content.length > maxOutputChars } }
      })
      return [search, shell] as const
    },
  }
}
