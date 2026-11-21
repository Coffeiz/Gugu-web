import { computed, inject, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { splitMindTitleBody } from '@/composables/mind/useMindEditor'
import { mindAccessKey } from '@/services/mindAccess'
import type { MindCanvas, MindCanvasItem } from '@/services/api'
import { accountBoundaryEpoch } from '@/utils/accountBoundary'
import { parseUtc } from '@/utils/dateAttribution'
import { sanitizeChatHtml } from '@/utils/markdown'
import { mindPreviewText } from '@/utils/mindReferences'
import { objectCardLoading } from './chatObjectCards'

function noteCards(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLAnchorElement>('a.chat-object-card')].flatMap(card => {
    const href = card.getAttribute('href') ?? ''
    const note = /^gugu:\/\/open-object\/note\/([1-9]\d*)$/i.exec(href)
    const canvas = /^gugu:\/\/focus-canvas\/([1-9]\d*)\/([1-9]\d*)$/i.exec(href)
    const id = Number(note?.[1] ?? canvas?.[2])
    const canvasId = canvas ? Number(canvas[1]) : undefined
    return Number.isSafeInteger(id) && (canvasId === undefined || Number.isSafeInteger(canvasId))
      ? [{ card, href, id, canvasId }] : []
  })
}

export function useChatNoteCards(html: () => string, enabled: () => boolean) {
  const access = inject(mindAccessKey, null)
  const { t, locale } = useI18n()
  // 键不存在时表示读取中，空值表示无法访问。
  const notes = shallowRef(new Map<string, { title: string; excerpt: string; recordedAt?: string; canvasTitle?: string } | null>())
  const dateFormat = computed(() => new Intl.DateTimeFormat(locale.value, {
    year: 'numeric', month: 'short', day: 'numeric',
  }))
  const root = computed(() => {
    const source = html()
    if (!enabled() || !access || !/data-object-type="(?:note|canvas)"/.test(source)) return
    const element = document.createElement('div')
    element.innerHTML = sanitizeChatHtml(source)
    return element
  })
  const links = computed(() => JSON.stringify([...new Set(root.value ? noteCards(root.value).map(({ href }) => href) : [])]))
  watch([links, accountBoundaryEpoch], ([, epoch], _previous, onCleanup) => {
    notes.value = new Map()
    if (!access || !root.value) return
    let current = true
    onCleanup(() => { current = false })
    const targets = new Map(noteCards(root.value).map(item => [item.href, item]))
    let canvases: Promise<MindCanvas[]> | undefined
    const canvasItems = new Map<number, Promise<MindCanvasItem[]>>()
    for (const [href, { id, canvasId }] of targets) {
      void (async () => {
        let note
        let canvasTitle
        if (canvasId === undefined) {
          note = await access.getNote(id)
        } else {
          let items = canvasItems.get(canvasId)
          if (!items) {
            items = access.listCanvasItems(canvasId)
            canvasItems.set(canvasId, items)
          }
          note = (await items).find(item => item.canvasId === canvasId && item.nodeId === id)?.node
          if (note) {
            canvases ??= access.listCanvases().catch(() => [])
            canvasTitle = (await canvases).find(canvas => canvas.id === canvasId)?.title
          }
        }
        if (!note) return null
        if (note.id !== id || note.deletedAt) return null
        const { titleMarkdown, body } = splitMindTitleBody(note.contentMd)
        const firstBlock = body.trim().split(/\r?\n\s*\r?\n|^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/m)
          .find(block => block.trim()) ?? ''
        const excerpt = Array.from(mindPreviewText(firstBlock))
        return {
          title: mindPreviewText(titleMarkdown) || (canvasId !== undefined && note.kind === 'ref' ? note.title ?? '' : ''),
          excerpt: excerpt.length > 220 ? excerpt.slice(0, 220).join('') + '…' : excerpt.join(''),
          recordedAt: canvasId === undefined ? note.capturedAt : undefined,
          canvasTitle,
        }
      })().catch(() => null).then(note => {
        if (current && accountBoundaryEpoch.value === epoch)
          notes.value = new Map(notes.value).set(href, note)
      })
    }
  }, { immediate: true })

  return computed(() => {
    if (!root.value || links.value === '[]') return html()
    const output = root.value.cloneNode(true) as HTMLElement
    for (const { card, href, canvasId } of noteCards(output)) {
      const note = notes.value.get(href)
      if (note === undefined) card.append(objectCardLoading(t('viewerUi.loading')))
      if (!note) continue
      card.dataset.chatCardLoaded = ''
      const title = note.title || t(note.excerpt ? 'mindUi.untitled' : 'mindUi.emptyNote')
      const heading = card.querySelector('.chat-object-card-title')
      if (heading) heading.textContent = title
      card.setAttribute('aria-label', title)
      const date = note.recordedAt ? parseUtc(note.recordedAt) : null
      if (date && Number.isFinite(date.getTime())) {
        const recordedAt = document.createElement('time')
        recordedAt.className = 'chat-note-card-date'
        recordedAt.dateTime = date.toISOString()
        recordedAt.textContent = dateFormat.value.format(date)
        card.querySelector('.chat-object-card-heading')?.append(recordedAt)
      }
      card.querySelector('.chat-object-card-description')?.remove()
      if (note.excerpt) {
        const excerpt = document.createElement('span')
        excerpt.className = 'chat-object-card-description'
        excerpt.textContent = note.excerpt
        card.append(excerpt)
      }
      if (canvasId !== undefined) {
        const context = document.createElement('span')
        context.className = 'chat-canvas-card-context'
        const icon = card.querySelector('.chat-object-card-icon')
        if (icon) {
          icon.setAttribute('aria-hidden', 'true')
          context.append(icon)
        }
        const label = document.createElement('span')
        const canvasName = note.canvasTitle?.trim() || `#${canvasId}`
        label.textContent = `${t('chatUi.objectCardTypes.canvas')} · ${canvasName}`
        label.title = label.textContent
        context.append(label)
        card.append(context)
      }
    }
    return output.innerHTML
  })
}
