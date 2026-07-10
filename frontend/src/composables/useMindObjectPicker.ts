/**
 * 便签里输入 `[[` 时的对象引用补全：查项目 / 文件 / 日历活动。
 *
 * 防抖 + 请求序号：输入快时旧请求可能后到，用递增 seq 丢弃过期响应，
 * 免得下拉里闪回上一个关键词的结果（顶栏全局搜索也是这个套路）。
 */
import { ref } from 'vue'
import { mindApi, type MindRefSuggestItem } from '@/services/api'

export function useMindObjectPicker(delay = 180) {
  const items   = ref<MindRefSuggestItem[]>([])
  const loading = ref(false)
  const active  = ref(0)          // 键盘高亮项

  let timer: ReturnType<typeof setTimeout> | null = null
  let seq = 0

  function search(q: string) {
    if (timer) clearTimeout(timer)
    const text = (q ?? '').trim()
    if (!text) { items.value = []; loading.value = false; return }

    loading.value = true
    timer = setTimeout(async () => {
      const mine = ++seq
      try {
        const r = await mindApi.refSuggest(text, 6)
        if (mine === seq) { items.value = r; active.value = 0 }
      } catch {
        if (mine === seq) items.value = []
      } finally {
        if (mine === seq) loading.value = false
      }
    }, delay)
  }

  function reset() {
    if (timer) clearTimeout(timer)
    seq++                          // 让在途请求的结果作废
    items.value = []
    loading.value = false
    active.value = 0
  }

  function move(delta: number) {
    if (!items.value.length) return
    active.value = (active.value + delta + items.value.length) % items.value.length
  }

  return { items, loading, active, search, reset, move }
}
