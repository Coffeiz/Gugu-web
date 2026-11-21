import { getThumb, getCachedThumb, getThumbUrl, getCachedThumbUrl } from '@/composables/shared/useThumbCache'
import { API_BASE } from './chatConstants'

// IntersectionObserver 懒加载指令：进视口附近才取 card 尺寸缩略图。
// 值为数字 file_id → 文件库缩略图；为字符串 attach_id → 暂存附件缩略图端点。
export interface ThumbEl extends HTMLImageElement {
  _thumbObs?: IntersectionObserver | null
  _thumbKey?: string
  _thumbGeneration?: number
  _attachmentUrl?: string
}

function releaseAttachmentUrl(el: ThumbEl) {
  if (el._attachmentUrl) URL.revokeObjectURL(el._attachmentUrl)
  el._attachmentUrl = undefined
}

export function bindLazyThumb(el: ThumbEl, id: number | string | undefined | null, size = 'card',
  readAttachment?: (id: string) => Promise<Blob>) {
  releaseAttachmentUrl(el)
  el._thumbObs?.disconnect()
  el._thumbObs = null
  const generation = (el._thumbGeneration ?? 0) + 1
  el._thumbGeneration = generation
  el._thumbKey = id == null || id === '' ? undefined : String(id)
  // DOM 节点会被虚拟列表复用；切换附件时先清掉旧图，避免旧 blob 在新附件加载前残留。
  el.removeAttribute('src')
  if (!id) return

  const isAttach = typeof id === 'string'
  const key = isAttach ? `att:${id}_${size}` : `${id}_${size}`
  const readLocal = isAttach ? readAttachment : undefined
  const cached = readLocal ? null : isAttach ? getCachedThumbUrl(key) : getCachedThumb(id, size)
  if (cached) { el.src = cached; return }
  const fetchThumb = () => isAttach
    ? getThumbUrl(key, `${API_BASE}/agent/attachment/${id}/thumb?size=${size}`)
    : getThumb(id, size)
  const obs = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return
    obs.disconnect(); el._thumbObs = null
    const current = () => el._thumbGeneration === generation && el._thumbKey === String(id)
    if (readLocal && typeof id === 'string') {
      void readLocal(id).then(blob => {
        if (!current()) return
        el._attachmentUrl = URL.createObjectURL(blob)
        el.src = el._attachmentUrl
      }).catch(() => {})
    } else {
      void fetchThumb().then(url => { if (url && current()) el.src = url })
    }
  }, { rootMargin: '200px' })
  obs.observe(el)
  el._thumbObs = obs
}

export function makeLazyThumbDirective(size: string, readAttachment?: (id: string) => Promise<Blob>) {
  return {
    mounted(el: ThumbEl, { value }: { value: number | string | undefined | null }) { bindLazyThumb(el, value, size, readAttachment) },
    updated(el: ThumbEl, { value, oldValue }: { value: number | string | undefined | null; oldValue: number | string | undefined | null }) {
      if (value !== oldValue) bindLazyThumb(el, value, size, readAttachment)
    },
    unmounted(el: ThumbEl) {
      releaseAttachmentUrl(el)
      el._thumbObs?.disconnect(); el._thumbObs = null
      el._thumbGeneration = (el._thumbGeneration ?? 0) + 1
      el._thumbKey = undefined
    },
  }
}
