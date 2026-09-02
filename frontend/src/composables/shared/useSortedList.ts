import { computed, type ComputedRef, type Ref } from 'vue'

/**
 * 通用排序配置项：每个 sort key 一个 option，含可选的 compare 函数。
 * 不传 compare 时，useSortedList 会 fallback 到按 id 稳定排序——跟 useFileProjection
 * 保持一致行为，方便未来把 useFileProjection 内部也改成 useSortedList 调用。
 */
export interface SortOption<T = unknown> {
  /** 排序 key 标识，跟 useSorting 返回的 sortKey 配对 */
  key: string
  /** 菜单里显示的标签 */
  label: string
  /** 返回 < 0 / 0 / > 0 表示 a 应该排在 b 前面/相等/后面。dir 已包含在 compare 内（不用自己乘）。 */
  compare?: (a: T, b: T) => number
  /** 可选：菜单里显示的图标组件 */
  icon?: unknown
}

export type SortDir = 'asc' | 'desc'

/**
 * 配置驱动的排序 composable：传 list + sortKey + sortDir + sortOptions，
 * 返回 computed sortedList。compare 找不到或未声明时 fallback 到按 id 稳定排序，
 * 跟 useFileProjection 的兜底行为一致。
 *
 * 设计意图：跟 useSorting 解耦——useSorting 只管 state（sortKey / sortDir / 菜单触发），
 * useSortedList 只管根据 state 算 sorted list。useSorting + useSortedList 组合使用，
 * 但 useSortedList 单独也能用（接任何 Ref<string> 形式的 sortKey 来源）。
 */
export function useSortedList<T extends { id: number | string }>(
  list: Ref<T[]>,
  sortKey: Ref<string>,
  sortDir: Ref<SortDir>,
  sortOptions: SortOption<T>[],
): ComputedRef<T[]> {
  return computed(() => {
    const opt = sortOptions.find(o => o.key === sortKey.value)
    const dir = sortDir.value === 'asc' ? 1 : -1
    if (!opt?.compare) {
      // 没找到 compare 或没声明 → 保持原顺序（按 id 升序，跟 useFileProjection 兜底一致）
      return [...list.value].sort((a, b) => (a.id > b.id ? 1 : a.id < b.id ? -1 : 0))
    }
    return [...list.value].sort((a, b) => dir * opt.compare!(a, b))
  })
}
