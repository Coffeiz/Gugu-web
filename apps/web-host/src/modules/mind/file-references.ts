import { CoreError } from '@gugu/core'
import type { Pool } from 'pg'
import { createDiskFileSearchSources } from '../search/files.js'
import { createWorkspaceFileReads } from '../workspaces/files.js'

/** 候选只从当前用户的授权目录生成，引用保存目录、相对路径和当时的文件身份。 */
export function createMindFileReferences(pool: Pool, storageRoot: string, includeFolders = false) {
  const sources = createDiskFileSearchSources(pool, storageRoot)
  const files = createWorkspaceFileReads(pool, storageRoot)
  return async (owner: string, query: string, limit: number, signal?: AbortSignal) => {
    if (!query) return []
    const types = includeFolders ? ['file', 'folder'] as const : ['file'] as const
    const search = { q: query, queries: [query], types, mode: 'OR', perType: limit } as const
    const hits = (await Promise.all(sources.filter(source => includeFolders || source.type === 'file').map(async source =>
      (await source.search(owner, search, signal)).map(hit => ({ hit, type: source.type }))
    ))).flat()
    const references = await Promise.all(hits.map(async ({ hit, type }) => {
      signal?.throwIfAborted()
      const { directoryId, relativePath, location } = hit.path_file
      if (type === 'folder' && 'link' in hit && typeof hit.link === 'string')
        return { type, id: hit.link.slice('gugu://open-object/folder/'.length), label: hit.title, subtitle: hit.subtitle, location }
      const directory = typeof directoryId === 'string' && directoryId !== 'personal'
        ? { projectId: Number(directoryId.slice('project:'.length)) } : directoryId
      try {
        return await files.reference(owner, directory, relativePath, undefined, type === 'folder' ? 'folder' : 'file')
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
