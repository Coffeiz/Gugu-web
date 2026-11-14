import { computed, ref, reactive, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'

export type SortDir = 'asc' | 'desc'

export const SORT_OPTION_KEYS = ['name', 'type', 'stage', 'createdAt', 'size'] as const

const SORT_STORAGE_PREFIX = 'gugu-file-sort:'

function isSortKey(value: unknown): value is typeof SORT_OPTION_KEYS[number] {
  return typeof value === 'string' && (SORT_OPTION_KEYS as readonly string[]).includes(value)
}

function isSortDir(value: unknown): value is SortDir {
  return value === 'asc' || value === 'desc'
}

/** 读取一个 surface 持久化的排序选择；脏数据（解析失败/白名单外）一律回默认。 */
export function readStoredFileSort(storageKey: string): { key: string; dir: SortDir } | null {
  try {
    const raw = window.localStorage.getItem(SORT_STORAGE_PREFIX + storageKey)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { key?: unknown; dir?: unknown }
    if (!isSortKey(parsed.key) || !isSortDir(parsed.dir)) return null
    return { key: parsed.key, dir: parsed.dir }
  } catch {
    return null
  }
}

function writeStoredFileSort(storageKey: string, key: string, dir: SortDir): void {
  try {
    window.localStorage.setItem(SORT_STORAGE_PREFIX + storageKey, JSON.stringify({ key, dir }))
  } catch {
    // 隐私模式等场景写不进就算了：排序偏好不值得打扰用户。
  }
}

/**
 * 列表排序选择；传入 storageKey 时按 surface 持久化到 localStorage
 * （刷新/重开浏览器恢复上次的排序键与方向），不传则维持纯内存行为。
 */
export function useSorting(storageKey?: string) {
  const { t } = useI18n()
  const SORT_OPTIONS = computed(() => SORT_OPTION_KEYS.map(key => ({
    key,
    label: t(`filesViewUi.${key === 'stage' ? 'projectStage' : key === 'createdAt' ? 'date' : key}`),
  })))
  const stored = storageKey ? readStoredFileSort(storageKey) : null
  const sortKey      = ref(stored?.key ?? 'name')
  const sortDir: Ref<SortDir> = ref<SortDir>(stored?.dir ?? 'asc')
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
    if (storageKey) writeStoredFileSort(storageKey, sortKey.value, sortDir.value)
    sortMenuOpen.value = false
  }

  return { SORT_OPTIONS, sortKey, sortDir, sortMenuOpen, sortBtnRef, sortMenuPos, openSortMenu, onSortSelect }
}
