/**
 * 缩略图懒加载指令 vLazyThumb · 单一来源
 *
 * 文件库与项目卡原先各自抄了一份几乎相同的 IntersectionObserver 懒加载指令，这里收口。
 * 用法（模板）：<img v-lazy-thumb="{ id: file.id, size: 'tiny' }" />
 *
 * 行为：tiny 与 card 都视口门控——屏幕外缩略图不全量加载、不挤占 useThumbCache 的 6 并发队列、
 * 不堵住可见卡片的 card 请求。tiny 用更大的 rootMargin 先进入触发区 → 同一张卡 tiny 先入队，
 * blur 占位仍先于 card 出现。card 设 src 后预解码（el.decode），滚入视口零开销。
 */
import { getThumb, getCachedThumb } from '@/composables/useThumbCache'

// 指令挂在 <img> 上，额外记两个私有句柄用于断开/重试
type LazyThumbEl = HTMLImageElement & { _lazyThumbObs?: IntersectionObserver | null; _lazyThumbRetry?: ReturnType<typeof setTimeout> | null }
type LazyThumbValue = { id?: number | string; size?: string }

const ROOT_MARGIN: Record<string, string> = { tiny: '400px', card: '250px' }

function _load(el: LazyThumbEl, id: number | string, size: string = 'card', tries = 0) {
  const cached = getCachedThumb(id, size)
  if (cached) {
    el.src = cached
    if (size === 'card') el.decode?.().catch(() => {})
    return
  }
  const obs = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return
    obs.disconnect(); el._lazyThumbObs = null
    getThumb(id, size).then((url: string | null | undefined) => {
      if (url) { el.src = url; if (size === 'card') el.decode?.().catch(() => {}) }
      // 失败（瞬时网络抖动 / 并发槽超时）别永久空着——退避后重挂观察，下次进视口再试。
      // 有上限（最多 3 次）+ setTimeout 退避，避免「仍在视口 → 立即再触发 → 失败 → 再试」的紧贴死循环。
      else if (tries < 3) {
        el._lazyThumbRetry = setTimeout(() => { el._lazyThumbRetry = null; _load(el, id, size, tries + 1) }, 600 * (tries + 1))
      }
    })
  }, { rootMargin: ROOT_MARGIN[size] ?? '250px' })
  obs.observe(el)
  el._lazyThumbObs = obs
}

export const vLazyThumb = {
  mounted(el: LazyThumbEl, { value: { id, size } }: { value: LazyThumbValue }) {
    if (id) _load(el, id, size)
  },
  updated(el: LazyThumbEl, { value: { id, size }, oldValue }: { value: LazyThumbValue; oldValue?: LazyThumbValue }) {
    if (id === oldValue?.id && size === oldValue?.size) return
    el._lazyThumbObs?.disconnect()
    if (el._lazyThumbRetry) { clearTimeout(el._lazyThumbRetry); el._lazyThumbRetry = null }
    if (id) _load(el, id, size)
  },
  unmounted(el: LazyThumbEl) {
    el._lazyThumbObs?.disconnect()
    el._lazyThumbObs = null
    if (el._lazyThumbRetry) { clearTimeout(el._lazyThumbRetry); el._lazyThumbRetry = null }
  },
}
