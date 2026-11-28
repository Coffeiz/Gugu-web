import { SearchError } from './errors.js'
import type { GlobalSearchQuery, GlobalSearchType } from './query.js'
import type { GlobalSearchSource } from './service.js'

/** 让文件与文件夹来源共享宿主的一次文件扫描结果。 */
export function createFileSearchSources(
  search: (query: Pick<GlobalSearchQuery, 'queries' | 'mode' | 'perType'>, signal?: AbortSignal) => Promise<unknown>,
): GlobalSearchSource[] {
  const pending = new WeakMap<GlobalSearchQuery, Promise<Array<{ type: GlobalSearchType; items: readonly Record<string, unknown>[] }>>>()
  return (['file', 'folder'] as const).map(type => ({
    type, label: type === 'file' ? '文件' : '文件夹',
    async search(_owner, query, signal) {
      let groups = pending.get(query)
      if (!groups) {
        const { queries, mode, perType } = query
        groups = search({ queries, mode, perType }, signal).then(result => {
          if (!result || typeof result !== 'object' || !('groups' in result) || !Array.isArray(result.groups))
            throw new SearchError('storage_error', '文件搜索结果无效')
          return result.groups as Array<{ type: GlobalSearchType; items: readonly Record<string, unknown>[] }>
        })
        pending.set(query, groups)
      }
      return (await groups).find(group => group.type === type)?.items ?? []
    },
  }))
}
