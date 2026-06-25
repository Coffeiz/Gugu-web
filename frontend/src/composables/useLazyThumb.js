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

const ROOT_MARGIN = { tiny: '400px', card: '250px' }

function _load(el, id, size) {
  const cached = getCachedThumb(id, size)
  if (cached) {
    el.src = cached
    if (size === 'card') el.decode?.().catch(() => {})
    return
  }
  const obs = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return
    obs.disconnect(); el._lazyThumbObs = null
    getThumb(id, size).then(url => {
      if (url) { el.src = url; if (size === 'card') el.decode?.().catch(() => {}) }
    })
  }, { rootMargin: ROOT_MARGIN[size] ?? '250px' })
  obs.observe(el)
  el._lazyThumbObs = obs
}

export const vLazyThumb = {
  mounted(el, { value: { id, size } }) {
    if (id) _load(el, id, size)
  },
  updated(el, { value: { id, size }, oldValue }) {
    if (id === oldValue?.id && size === oldValue?.size) return
    el._lazyThumbObs?.disconnect()
    if (id) _load(el, id, size)
  },
  unmounted(el) {
    el._lazyThumbObs?.disconnect()
    el._lazyThumbObs = null
  },
}
