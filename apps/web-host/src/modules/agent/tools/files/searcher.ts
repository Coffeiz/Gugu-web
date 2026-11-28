import { extname } from 'node:path'
import { CoreError } from '@gugu/core'
import type { Pool } from 'pg'
import { createSearcherReferenceSearch, createSearcherReferenceShell, type RunIdentity } from '@gugu/core/agent'
import { createOwnedTextReader } from '@gugu/core/tools'
import { createWorkspaceFileReads } from '../../../workspaces/files.js'
import { parseWorkspaceFileReference } from '../../context/references.js'
import { webAgentFileTextType } from './read.js'

function fileReference(value: unknown) {
  if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'file' || !('id' in value)) return null
  return parseWorkspaceFileReference(value.id)
}

export function createWebSearcherFileAccess(pool: Pick<Pool, 'query'>, storageRoot: string) {
  const workspaceFiles = createWorkspaceFileReads(pool, storageRoot)
  const workspacePrefix = 'searcher-workspace-ref:'
  async function listed(parent: RunIdentity, refs: readonly string[], signal: AbortSignal) {
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
    const results = new Map<string, { ref: string; label: string; workspace: NonNullable<ReturnType<typeof parseWorkspaceFileReference>> }>()
    for (const raw of row.references_json.slice(0, 6)) {
      const workspace = fileReference(raw)
      if (!workspace || !selected.has(workspace.key) || results.has(workspace.key)) continue
      const { directory, relativePath, identity, key } = workspace
      try {
        const file = await workspaceFiles.reference(parent.ownerId, directory, relativePath, identity)
        results.set(key, { ref: key, label: file.label, workspace })
      } catch (error) {
        if (!(error instanceof CoreError) || error.code !== 'not_found') throw error
      }
      signal.throwIfAborted()
    }
    return [...results.values()]
  }
  return {
    async authorize(parent: RunIdentity, refs: readonly string[]) {
      const allowed = new Set((await listed(parent, refs, new AbortController().signal)).map(file => file.ref))
      return refs.every(ref => allowed.has(ref))
    },
    tools(parent: RunIdentity, child: RunIdentity, refs: readonly string[],
      authorizeShell: (signal: AbortSignal) => Promise<boolean>) {
      if (!refs.length) return []
      const scope = new Set(refs)
      const search = createSearcherReferenceSearch(async signal => (await listed(parent, refs, signal)).map(({ ref, label }) => ({ ref, label })))
      const reader = createOwnedTextReader({
        async openFile(_root, path) {
          if (!path.startsWith(workspacePrefix)) return null
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
      })
      const shell = createSearcherReferenceShell(async (ref, toolScope, maxOutputChars) => {
        if (!await authorizeShell(toolScope.signal))
          return { kind: "completed", successful: false, executed: false, mutated: false, value: { error: "Shell 权限已失效" } }
        const result = await reader({ file: ref }, toolScope)
        if (result.kind !== "completed" || !result.successful) return result
        const value = result.value as { content: string; name: string }
        return { ...result, executed: true, value: { stdout: value.content.slice(0, maxOutputChars),
          name: value.name, truncated: value.content.length > maxOutputChars } }
      })
      return [search, shell] as const
    },
  }
}
