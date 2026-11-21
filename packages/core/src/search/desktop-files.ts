import { CoreError } from '../contracts/index.js'
import type { DesktopSearchResult } from '../contracts/desktop.js'
import type { GlobalSearchSource } from './global-search.js'
import type { GlobalSearchQuery } from './query.js'

/** 文件和文件夹分组共用一次由桌面宿主执行的工作区扫描。 */
export function createDesktopFileSearchSources(
  search: (params: Pick<GlobalSearchQuery, 'queries' | 'mode' | 'perType'>, signal?: AbortSignal) => Promise<unknown>,
): GlobalSearchSource[] {
  const pending = new WeakMap<GlobalSearchQuery, Promise<DesktopSearchResult['groups']>>()
  return (['file', 'folder'] as const).map(type => ({
    type, label: type === 'file' ? '文件' : '文件夹',
    async search(_owner, query, signal) {
      let groups = pending.get(query)
      if (!groups) {
        const { queries, mode, perType } = query
        groups = search({ queries, mode, perType }, signal).then(result => {
          if (!result || typeof result !== 'object' || !('groups' in result) || !Array.isArray(result.groups))
            throw new CoreError('storage_error', '桌面文件搜索结果无效')
          return result.groups as DesktopSearchResult['groups']
        })
        pending.set(query, groups)
      }
      return (await groups).find(group => group.type === type)?.items ?? []
    },
  }))
}
