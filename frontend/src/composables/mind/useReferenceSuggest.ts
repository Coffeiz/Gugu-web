import { ref } from 'vue'
import { mindApi, type MindRefSuggestItem } from '@/services/api'

/** 公共对象引用补全状态：笔记和聊天共用防抖、请求序号和键盘选择行为。 */
export function useReferenceSuggest(delay = 180) {
  const items = ref<MindRefSuggestItem[]>([])
  const loading = ref(false)
  const active = ref(0)
  let timer: ReturnType<typeof setTimeout> | null = null
  let seq = 0

  function search(query: string) {
    if (timer) clearTimeout(timer)
    // 在排队阶段就使上一轮请求失效；否则旧请求可能恰好在新防抖计时器触发前返回，
    // 把上一条关键词的结果短暂写回当前弹窗。
    const request = ++seq
    const text = (query ?? '').trim()
    loading.value = true
    timer = setTimeout(async () => {
      try {
        const result = await mindApi.refSuggest(text, 6)
        if (request === seq) { items.value = result; active.value = 0 }
      } catch {
        if (request === seq) items.value = []
      } finally {
        if (request === seq) loading.value = false
      }
    }, delay)
  }

  function reset() {
    if (timer) clearTimeout(timer)
    timer = null
    seq++
    items.value = []
    loading.value = false
    active.value = 0
  }

  function move(delta: number) {
    if (items.value.length) active.value = (active.value + delta + items.value.length) % items.value.length
  }

  return { items, loading, active, search, reset, move }
}
