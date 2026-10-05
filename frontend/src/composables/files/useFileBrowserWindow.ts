import { computed, inject, nextTick, onMounted, onScopeDispose, ref, watch, type ComponentPublicInstance, type InjectionKey, type Ref } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import type { FileMeta } from '@/stores/filesCache'
import type { FolderCard } from '@/utils/filesNav'
import { fileWindowHitIndices, type SelectionBox } from './fileWindowGeometry'

export type { SelectionBox } from './fileWindowGeometry'
export type WindowHitTest = (box: SelectionBox) => { fileIds: Set<number>; folderIds: Set<string | number> } | null
export const fileWindowHitTestKey: InjectionKey<Ref<WindowHitTest | null>> = Symbol('file-window-hit-test')

/** 数据保持完整，窗口只决定挂载哪些行；不占用 Runtime 的 transform。 */
export function useFileBrowserWindow(contents: Ref<{ folders: FolderCard[]; files: FileMeta[] }>, mode: 'grid' | 'list', options: { tailCount?: () => number; resetKey?: () => unknown } = {}) {
  const browserRef = ref<ComponentPublicInstance | null>(null)
  const scrollElement = ref<HTMLElement | null>(null)
  const columns = ref(1)
  const stride = ref(mode === 'grid' ? 144 : 41)
  const margin = ref(0)
  const gap = mode === 'grid' ? 10 : 2
  const hitTest = inject(fileWindowHitTestKey, null)
  const count = computed(() => contents.value.folders.length + contents.value.files.length)
  const totalCount = computed(() => count.value + (options.tailCount?.() ?? 0))
  const enabled = computed(() => count.value > 100)
  const virtualizer = useVirtualizer(computed(() => ({
    count: Math.ceil(totalCount.value / columns.value),
    getScrollElement: () => scrollElement.value,
    estimateSize: () => stride.value,
    scrollMargin: margin.value,
    overscan: 3,
    enabled: enabled.value,
  })))
  const rows = computed(() => virtualizer.value.getVirtualItems())
  const start = computed(() => enabled.value ? (rows.value[0]?.index ?? 0) * columns.value : 0)
  const end = computed(() => enabled.value ? Math.min(totalCount.value, ((rows.value.at(-1)?.index ?? 0) + 1) * columns.value) : totalCount.value)
  const visibleFolders = computed(() => contents.value.folders.slice(start.value, end.value))
  const visibleFiles = computed(() => contents.value.files.slice(Math.max(0, start.value - contents.value.folders.length), Math.max(0, end.value - contents.value.folders.length)))
  const top = computed(() => enabled.value ? Math.floor(start.value / columns.value) * stride.value : 0)
  const bottom = computed(() => enabled.value ? Math.max(0, (Math.ceil(totalCount.value / columns.value) - Math.ceil(end.value / columns.value)) * stride.value) : 0)
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
  const resolveBox: WindowHitTest = (box) => {
    if (!enabled.value) return null
    const fileIds = new Set<number>()
    const folderIds = new Set<string | number>()
    const element = browserRef.value?.$el as HTMLElement | undefined
    const scroll = scrollElement.value
    if (!element || !scroll) return { fileIds, folderIds }
    const style = getComputedStyle(element)
    const insetLeft = parseFloat(style.paddingLeft) || 0
    const insetRight = parseFloat(style.paddingRight) || 0
    const left = element.getBoundingClientRect().left - scroll.getBoundingClientRect().left + insetLeft
    const indices = fileWindowHitIndices(box, { count: count.value, columns: columns.value, stride: stride.value, gap, left, top: margin.value, width: element.clientWidth - insetLeft - insetRight })
    for (const index of indices) {
      const folder = contents.value.folders[index]
      const file = contents.value.files[index - contents.value.folders.length]
      if (folder) folderIds.add(folder.id)
      else if (file) fileIds.add(file.id)
    }
    return { fileIds, folderIds }
  }
  onMounted(() => {
    const element = browserRef.value?.$el as HTMLElement | undefined
    scrollElement.value = element?.closest<HTMLElement>('.scroll-surface') ?? null
    measure()
    observer = new ResizeObserver(measure)
    if (element) observer.observe(element)
    if (scrollElement.value) observer.observe(scrollElement.value)
    if (hitTest) hitTest.value = resolveBox
  })
  watch(stride, () => virtualizer.value.measure())
  if (options.resetKey) watch(options.resetKey, () => {
    if (scrollElement.value) scrollElement.value.scrollTop = 0
  })
  watch(contents, async () => {
    await nextTick()
    measure()
  })
  onScopeDispose(() => {
    observer?.disconnect()
    if (hitTest?.value === resolveBox) hitTest.value = null
  })
  const tailStart = computed(() => Math.max(0, start.value - count.value))
  const tailEnd = computed(() => Math.max(0, end.value - count.value))
  return { browserRef, visibleFolders, visibleFiles, gridStyle, top, bottom, tailStart, tailEnd, virtualEnabled: enabled }
}
