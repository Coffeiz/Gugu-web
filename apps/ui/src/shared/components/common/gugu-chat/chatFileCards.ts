import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { decodeMindFileReference } from '@/composables/mind/fileReference'
import { usePathFileAccess } from '@/services/pathFileAccess'
import { accountBoundaryEpoch } from '@/utils/accountBoundary'
import { isImageExt } from '@/utils/fileTypes'
import { pLimit } from '@/utils/concurrency'
import { formatFileSize } from '@/utils/formatters'
import { sanitizeChatHtml } from '@/utils/markdown'
import { objectCardFact, objectCardLoading } from './chatObjectCards'

const loadFileMetadata = pLimit(5)
const fileLinkPrefix = 'gugu://open-object/file/'

function fileCards(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLAnchorElement>('a.chat-object-card[data-object-type="file"]')]
    .flatMap(card => {
      const href = card.getAttribute('href') ?? ''
      if (!href.startsWith(fileLinkPrefix)) return []
      const reference = href.slice(fileLinkPrefix.length)
      const file = decodeMindFileReference(reference)
      return file || /^drop-[A-Za-z0-9_-]{1,24000}$/u.test(reference) ? [{ card, href, file, reference }] : []
    })
}

export function useChatFileCards(html: () => string, unfinishedLine: () => string) {
  const files = usePathFileAccess()
  const { t } = useI18n()
  const sizes = shallowRef(new Map<string, number>())
  const pending = shallowRef(new Set<string>())
  const systemFiles = shallowRef(new Map<string, { name: string; size: number }>())
  const root = computed(() => {
    const source = html()
    if (!source.includes('data-object-type="file"')) return
    const element = document.createElement('div')
    element.innerHTML = sanitizeChatHtml(source)
    return element
  })
  const targets = computed(() => new Map((root.value ? fileCards(root.value) : [])
    .filter(item => item.href !== unfinishedLine() && (item.file || files.systemReferenceUrl))
    .map(item => [item.href, item])))
  const urls = computed(() => JSON.stringify([...targets.value.keys()]))
  const jobs = new Map<string, AbortController>()
  onScopeDispose(() => jobs.forEach(job => job.abort()))

  watch([urls, accountBoundaryEpoch], ([, epoch], previous) => {
    const reset = previous?.[1] !== epoch
    for (const [href, job] of jobs) {
      if (!reset && targets.value.has(href)) continue
      job.abort()
      jobs.delete(href)
    }
    const retain = <T>(values: Map<string, T>) => new Map([...values].filter(([href]) => jobs.has(href)))
    sizes.value = retain(sizes.value)
    systemFiles.value = retain(systemFiles.value)
    const waiting = new Set([...pending.value].filter(href => jobs.has(href)))
    for (const [href, { file, reference }] of targets.value) {
      if (jobs.has(href)) continue
      const controller = new AbortController()
      jobs.set(href, controller)
      waiting.add(href)
      const signal = controller.signal
      const current = () => !signal.aborted && epoch === accountBoundaryEpoch.value
      void loadFileMetadata(async () => {
        if (!current()) return
        if (!file) {
          const url = files.systemReferenceUrl?.(reference)
          if (!url) return
          const response = await fetch(url, { cache: 'no-store', signal })
          if (!response.ok) return
          const metadata = await response.json()
          if (typeof metadata?.name === 'string' && Number.isSafeInteger(metadata.size) && metadata.size >= 0 && current())
            systemFiles.value = new Map(systemFiles.value).set(href, { name: metadata.name, size: metadata.size })
          return
        }
        // 内容端点校验文件身份，Range 响应提供文件总大小。
        const response = await fetch(files.contentUrl(file), {
          headers: { Range: 'bytes=0-0' }, credentials: 'include', cache: 'no-store', signal,
        })
        const range = response.headers.get('Content-Range') ?? ''
        const size = response.status === 206 ? Number(/^bytes 0-0\/(\d+)$/.exec(range)?.[1])
          : response.status === 416 && range === 'bytes */0' ? 0 : NaN
        void response.body?.cancel().catch(() => {})
        if (Number.isSafeInteger(size) && size >= 0 && current())
          sizes.value = new Map(sizes.value).set(href, size)
      }).catch(() => { /* 无法读取时保留原文件卡 */ }).finally(() => {
        if (!current()) return
        const remaining = new Set(pending.value)
        remaining.delete(href)
        pending.value = remaining
      })
    }
    pending.value = waiting
  }, { immediate: true })

  return computed(() => {
    if (!root.value) return html()
    const output = root.value.cloneNode(true) as HTMLElement
    for (const { card, href, file, reference } of fileCards(output)) {
      if (href === unfinishedLine()) {
        if (file || files.systemReferenceUrl) {
          const loading = objectCardLoading(t('viewerUi.loading'))
          loading.classList.add('is-streaming')
          card.append(loading)
        }
        continue
      }
      const systemFile = systemFiles.value.get(href)
      if (systemFile) {
        const title = card.querySelector('.chat-object-card-title')
        if (title) title.textContent = systemFile.name
        card.setAttribute('aria-label', systemFile.name)
      }
      const extension = /\.([^./]+)$/.exec(file?.relativePath ?? systemFile?.name ?? '')?.[1]
      const thumbnail = isImageExt(extension)
        ? file ? files.thumbnailUrl(file) : files.systemReferenceUrl?.(reference, true)
        : undefined
      if (thumbnail) {
        const preview = document.createElement('img')
        preview.className = 'chat-object-image-preview'
        preview.alt = ''
        preview.loading = 'lazy'
        preview.decoding = 'async'
        // 使用同源路径，让桌面缩略图通过 Markdown 的 URL 白名单。
        const desktopOrigin = 'gugu-desktop://app'
        preview.setAttribute('src', thumbnail.startsWith(desktopOrigin + '/')
          ? thumbnail.slice(desktopOrigin.length) : thumbnail)
        card.prepend(preview)
      }
      const waitingForMetadata = pending.value.has(href)
      if (waitingForMetadata || thumbnail)
        card.append(objectCardLoading(t('viewerUi.loading'), !waitingForMetadata))
      const size = systemFile?.size ?? sizes.value.get(href)
      if (size === undefined) continue
      card.dataset.chatCardLoaded = ''
      const details = document.createElement('span')
      details.className = 'chat-object-card-details'
      details.append(objectCardFact(t('files.size'), formatFileSize(size)))
      const parent = file?.relativePath.split('/').slice(0, -1).at(-1)
      if (parent) details.append(objectCardFact(t('files.folderLocation'), parent))
      card.append(details)
    }
    return output.innerHTML
  })
}
