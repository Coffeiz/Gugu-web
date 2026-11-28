import { watch, type WatchSource } from 'vue'

/** 资源 revision 变化（包括 SSE 重连补刷）后合并短时间内的重复刷新。 */
export function watchDebouncedRevision(
  source: WatchSource<number>,
  refresh: () => void,
  delayMs: number,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const stopWatch = watch(source, () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      refresh()
    }, delayMs)
  })

  return () => {
    stopWatch()
    if (timer) clearTimeout(timer)
    timer = null
  }
}
