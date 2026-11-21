import { computed, ref, watch, type Ref } from 'vue'
import { useMindStore } from '@/stores/mind'
import { localDayKey, parseUtc } from '@/utils/dateAttribution'

/** 按日期补齐笔记分页，避免较早日期被首页的最近 100 条截断。 */
export function useCalendarNotes(selectedDate: Ref<string | null>) {
  const mindStore = useMindStore()
  let requestSeq = 0
  const loading = ref(false)
  const failed = ref(false)

  const selectedNotes = computed(() => {
    const date = selectedDate.value
    if (!date) return []
    return mindStore.notes.filter(note => localDayKey(parseUtc(note.capturedAt)) === date)
  })

  watch(selectedDate, async date => {
    const seq = ++requestSeq
    failed.value = false
    if (!date) { loading.value = false; return }
    loading.value = true
    try {
      if (!mindStore.loaded) await mindStore.fetchNotes()
      if (seq !== requestSeq) return
      // API 按 capturedAt 日期倒序分页。同一天可能跨页，需读到最旧日期早于目标日。
      while (mindStore.hasMore && mindStore.notes.length) {
        if (mindStore.loadingMore) {
          await new Promise<void>(resolve => {
            const stop = watch(() => mindStore.loadingMore, isLoading => {
              if (!isLoading) { stop(); resolve() }
            })
          })
          if (seq !== requestSeq) return
        }
        const oldest = mindStore.notes[mindStore.notes.length - 1]
        if (localDayKey(parseUtc(oldest.capturedAt)) < date) break
        const countBefore = mindStore.notes.length
        await mindStore.loadMoreNotes()
        if (seq !== requestSeq || mindStore.notes.length === countBefore) break
      }
    } catch {
      if (seq === requestSeq) failed.value = true
    } finally {
      if (seq === requestSeq) loading.value = false
    }
  }, { immediate: true })

  return { selectedNotes, loading, failed }
}
