import { computed, nextTick, onMounted, onScopeDispose, ref, watch, type ComponentPublicInstance, type Ref } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import type { FolderCard } from '@/utils/filesNav'

/** 虚拟化只管理路径导航卡片的挂载，不占用 Runtime 的 transform。 */
export function useFileBrowserWindow(
  contents: Ref<{ folders: FolderCard[] }>,
  mode: 'grid' | 'list',
  options: { resetKey?: () => unknown } = {},
) {
  const browserRef = ref<ComponentPublicInstance | null>(null)
  const scrollElement = ref<HTMLElement | null>(null)
  const columns = ref(1)
  const stride = ref(mode === 'grid' ? 144 : 41)
  const margin = ref(0)
  const gap = mode === 'grid' ? 10 : 2
  const count = computed(() => contents.value.folders.length)
  const enabled = computed(() => count.value > 100)
  const virtualizer = useVirtualizer(computed(() => ({
    count: Math.ceil(count.value / columns.value),
    getScrollElement: () => scrollElement.value,
    estimateSize: () => stride.value,
    scrollMargin: margin.value,
    overscan: 3,
    enabled: enabled.value,
  })))
  const rows = computed(() => virtualizer.value.getVirtualItems())
  const start = computed(() => enabled.value ? (rows.value[0]?.index ?? 0) * columns.value : 0)
  const end = computed(() => enabled.value ? Math.min(count.value, ((rows.value.at(-1)?.index ?? 0) + 1) * columns.value) : count.value)
  const visibleFolders = computed(() => contents.value.folders.slice(start.value, end.value))
  const top = computed(() => enabled.value ? Math.floor(start.value / columns.value) * stride.value : 0)
  const bottom = computed(() => enabled.value ? Math.max(0, (Math.ceil(count.value / columns.value) - Math.ceil(end.value / columns.value)) * stride.value) : 0)
  const gridStyle = computed(() => ({ paddingTop: `${top.value}px`, paddingBottom: `${bottom.value}px` }))

  let observer: ResizeObserver | null = null
  function measure() {
    const element = browserRef.value?.$el as HTMLElement | undefined
    const scroll = scrollElement.value
    if (!element || !scroll) return
    columns.value = mode === 'grid' ? Math.max(1, getComputedStyle(element).gridTemplateColumns.split(' ').length) : 1
    const card = element.querySelector<HTMLElement>('[data-layout-role="card"]')
    if (card) stride.value = card.getBoundingClientRect().height + gap
    const header = mode === 'list' ? (element.querySelector<HTMLElement>('.list-head')?.getBoundingClientRect().height ?? 0) + 4 : 0
    margin.value = element.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop + header
  }
  onMounted(() => {
    const element = browserRef.value?.$el as HTMLElement | undefined
    scrollElement.value = element?.closest<HTMLElement>('.scroll-surface') ?? null
    measure()
    observer = new ResizeObserver(measure)
    if (element) observer.observe(element)
    if (scrollElement.value) observer.observe(scrollElement.value)
  })
  watch(stride, () => virtualizer.value.measure())
  if (options.resetKey) watch(options.resetKey, () => {
    if (scrollElement.value) scrollElement.value.scrollTop = 0
  })
  watch(contents, async () => {
    await nextTick()
    measure()
  })
  onScopeDispose(() => observer?.disconnect())
  return { browserRef, visibleFolders, gridStyle, top, bottom, virtualEnabled: enabled }
}
