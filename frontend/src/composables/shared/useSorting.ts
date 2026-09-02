import { computed, ref, reactive, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'

export type SortDir = 'asc' | 'desc'

export const SORT_OPTION_KEYS = ['name', 'type', 'stage', 'createdAt', 'size'] as const

export function useSorting() {
  const { t } = useI18n()
  const SORT_OPTIONS = computed(() => SORT_OPTION_KEYS.map(key => ({
    key,
    label: t(`filesViewUi.${key === 'stage' ? 'projectStage' : key === 'createdAt' ? 'date' : key}`),
  })))
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
