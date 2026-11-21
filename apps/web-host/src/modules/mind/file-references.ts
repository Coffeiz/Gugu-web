import { CoreError } from '@gugu/core'
import type { Pool } from 'pg'
import { createDiskFileSearchSources } from '../search/files.js'
import { createWorkspaceFileReads } from '../workspaces/files.js'

/** 候选只从当前用户的授权目录生成，正文保存沙盒路径及当时的文件身份。 */
export function createMindFileReferences(pool: Pool, storageRoot: string) {
  const [source] = createDiskFileSearchSources(pool, storageRoot)
  const files = createWorkspaceFileReads(pool, storageRoot)
  return async (owner: string, query: string, limit: number, signal?: AbortSignal) => {
    if (!query) return []
    const hits = await source!.search(owner, { q: query, queries: [query], types: ['file'], mode: 'OR', perType: limit }, signal)
    const references = await Promise.all(hits.map(async hit => {
      signal?.throwIfAborted()
      const { directoryId, relativePath } = hit.path_file
      const directory = typeof directoryId === 'string' && directoryId !== 'personal'
        ? { projectId: Number(directoryId.slice('project:'.length)) } : directoryId
      try {
        return await files.reference(owner, directory, relativePath)
      } catch (error) {
        if (error instanceof CoreError && error.code === 'not_found') return null
        throw error
      }
    }))
    return references.filter(item => item !== null)
  }
}

export function createMindFileReferenceResolver(pool: Pool, storageRoot: string) {
  const files = createWorkspaceFileReads(pool, storageRoot)
  return async (owner: string, id: string) => {
    if (!/^path-[A-Za-z0-9_-]{1,24000}$/u.test(id)) return null
    try {
      const value: unknown = JSON.parse(Buffer.from(id.slice(5), 'base64url').toString('utf8'))
      if (!value || typeof value !== 'object') return null
      const { directoryId, relativePath, identity } = value as Record<string, unknown>
      const project = typeof directoryId === 'string' && /^project:([1-9]\d*)$/u.exec(directoryId)
      const directory = project ? { projectId: Number(project[1]) }
        : directoryId === 'personal' || (typeof directoryId === 'number' && Number.isSafeInteger(directoryId) && directoryId > 0) ? directoryId : null
      if (directory === null || typeof relativePath !== 'string' || typeof identity !== 'string'
        || !/^\d{1,32}\.\d{1,32}\.\d{1,32}$/u.test(identity)) return null
      return await files.reference(owner, directory, relativePath, identity)
    } catch (error) {
      if (error instanceof SyntaxError || (error instanceof CoreError && ['not_found', 'forbidden', 'invalid_request'].includes(error.code))) return null
      throw error
    }
  }
}
