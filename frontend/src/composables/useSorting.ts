import { ref, reactive, type Ref } from 'vue'

export type SortDir = 'asc' | 'desc'

export const SORT_OPTIONS: { key: string; label: string }[] = [
  { key: 'name',      label: '名称' },
  { key: 'type',      label: '类型' },
  { key: 'stage',     label: '阶段' },
  { key: 'createdAt', label: '创建时间' },
  { key: 'size',      label: '大小' },
]

export function useSorting() {
  const sortKey      = ref('name')
  const sortDir: Ref<SortDir> = ref<SortDir>('asc')
  const sortMenuOpen = ref(false)
  const sortBtnRef   = ref<HTMLElement | null>(null)
  const sortMenuPos  = reactive({ x: 0, y: 0 })

  function openSortMenu() {
    if (sortMenuOpen.value) { sortMenuOpen.value = false; return }
    const r = sortBtnRef.value?.getBoundingClientRect()
    if (r) { sortMenuPos.x = r.left; sortMenuPos.y = r.bottom + 6 }
    sortMenuOpen.value = true
  }

  function onSortSelect(key: string) {
    if (sortKey.value === key) {
      sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
    } else {
      sortKey.value = key
      sortDir.value = 'asc'
    }
    sortMenuOpen.value = false
  }

  return { SORT_OPTIONS, sortKey, sortDir, sortMenuOpen, sortBtnRef, sortMenuPos, openSortMenu, onSortSelect }
}
