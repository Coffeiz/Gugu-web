<template>
  <div ref="messageContent" class="chat-assistant-content"
    @pointerover="onHover" @pointerout="onPointerOut" @focusin="onFocus" @focusout="scheduleClose" @click="onMessageClick"
    @input="onSmartInput" @load.capture="showLoadedImage" @error.capture="markImageFailed">
    <div class="msg-bubble md-body">
      <div v-for="(block, index) in blocks" :key="index" class="chat-assistant-block">
        <div v-if="block.stream" class="chat-smart-stream">
          <div class="chat-smart-stream-grid" :data-smart-ratio="block.stream.ratio">
            <div v-for="region in block.stream.regions" :key="region.name" class="chat-smart-stream-region" :data-region="region.name" :data-status="region.status">
              <MarkdownView :html="region.html" chat />
            </div>
          </div>
        </div>
        <MarkdownView v-else :html="block.html" :text="text" chat :stream-motion="presenting && !block.smart" :render-math="!presenting && !block.smart" />
      </div>
    </div>
  </div>
  <Teleport to="body">
    <Transition name="citation-preview">
      <aside v-if="active && source" ref="card" class="chat-citation-preview" role="dialog" :aria-label="t('chatUi.citationPreview')"
        tabindex="-1" :style="{ ...position, zIndex: previewZ }" @pointerenter="cancelClose" @pointerleave="scheduleClose"
        @focusin="cancelClose" @focusout="scheduleClose" @keydown.left.prevent="step(-1)" @keydown.right.prevent="step(1)">
        <div v-if="active.sources.length > 1" class="citation-controls">
          <button type="button" :aria-label="t('chatUi.citationPrevious')" :disabled="index === 0" @click="step(-1)">←</button>
          <button type="button" :aria-label="t('chatUi.citationNext')" :disabled="index === active.sources.length - 1" @click="step(1)">→</button>
          <span>{{ index + 1 }} / {{ active.sources.length }}</span>
        </div>
        <div class="citation-site">
          <span class="chat-source-icon" aria-hidden="true">
            <img v-if="source.icon" :key="source.icon" :src="source.icon" alt="" referrerpolicy="no-referrer"
              decoding="async" @load="showLoadedImage" />
          </span>
          {{ source.site }}
        </div>
        <a :href="source.url" target="_blank" rel="noopener noreferrer">{{ source.title || source.site }}</a>
        <p v-if="source.summary">{{ source.summary }}</p>
        <div v-if="source.date" class="citation-date">{{ source.date }}</div>
      </aside>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, h, inject, nextTick, onBeforeUnmount, ref, render, shallowRef, watch } from 'vue'
import { getActivePinia } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { nextZ, registerPopover } from '@/composables/core/windowz'
import MarkdownView from '@/components/common/content/MarkdownView.vue'
import { decorateChatSources, type ChatSource } from './chatSources'
import { useChatProjectCards } from './chatProjectCards'
import { useChatFileCards } from './chatFileCards'
import { useChatNoteCards } from './chatNoteCards'
import { useChatEventCards } from './chatEventCards'
import { useChatSkillCards } from './chatSkillCards'
import { useChatScheduleCards } from './chatScheduleCards'
import { chatCalendarEventsKey } from './chatPresentationAccess'
import { applyChatCardSnapshots, stripChatCardSnapshotMarkers } from './chatCardSnapshots'
import { useCitationSiteNames } from './useCitationSiteNames'
import Icon from '@/components/common/icons/Icon.vue'
import FlipChevron from '@/components/common/controls/FlipChevron.vue'
import { smartViewIcons, updateSmartViewControl } from './chatSmartLayout'
import { readSmartStream, type SmartStreamLayout } from './chatSmartStream'
import { handleSmartInteractiveClick, selectSmartViewOption } from './chatSmartInteractive'

const props = defineProps<{ html: string; text: string; presenting: boolean; sources?: readonly ChatSource[]; snapshotMessage?: string }>()
const emit = defineEmits<{ 'body-click': [event: MouseEvent] }>()
function onMessageClick(event: MouseEvent) {
  if (selectSmartViewOption(event.target) || handleSmartInteractiveClick(event.target)) return
  onClick(event)
  emit('body-click', event)
}
const { t } = useI18n()
const desktop = Boolean(inject(chatCalendarEventsKey, null))
const auth = !desktop && getActivePinia() ? useAuthStore() : null
const projectHtml = useChatProjectCards(() => stripChatCardSnapshotMarkers(props.html), () => !props.presenting)
const noteHtml = useChatNoteCards(() => projectHtml.value, () => !props.presenting)
const eventHtml = useChatEventCards(() => noteHtml.value, () => !props.presenting)
const skillHtml = useChatSkillCards(() => eventHtml.value, () => !props.presenting)
const scheduleHtml = useChatScheduleCards(() => skillHtml.value, () => !props.presenting)
// 裸地址要等换行或回复播完，避免提前请求仍在增长的引用。
const objectHtml = useChatFileCards(() => scheduleHtml.value,
  () => props.presenting ? props.text.slice(props.text.lastIndexOf('\n') + 1).trim() : '')
function showLoadedImage(event: Event) {
  const image = event.target
  if (!(image instanceof HTMLImageElement)) return
  if (image.classList.contains('chat-object-image-preview')) {
    image.classList.toggle('is-portrait', image.naturalHeight > image.naturalWidth)
    image.classList.add('is-loaded')
  } else if (image.parentElement?.classList.contains('chat-source-icon')) {
    image.classList.add('is-loaded')
  }
}
function markImageFailed(event: Event) {
  const image = event.target
  if (image instanceof HTMLImageElement && image.classList.contains('chat-object-image-preview'))
    image.classList.add('is-failed')
}
const namedSources = useCitationSiteNames(() => props.presenting ? [] : props.sources ?? [])
const decorated = computed(() => {
  const account = desktop ? 'desktop' : auth?.user?.id
  const html = !props.presenting && props.snapshotMessage && account
    ? applyChatCardSnapshots(objectHtml.value, JSON.stringify([account, props.snapshotMessage]), t('chatUi.cardSnapshot'))
    : objectHtml.value
  return !props.presenting && (namedSources.value.length || /(?:来源|Sources?)/iu.test(html))
    ? decorateChatSources(html, namedSources.value)
    : { html, groups: [] }
})

const blocks = computed(() => {
  const { html } = decorated.value
  const original: { html: string; smart: boolean; stream?: SmartStreamLayout }[] = [{ html, smart: false }]
  if (!html.includes('chat-smart-view')) return original
  const content = document.createElement('template')
  content.innerHTML = html
  const result: typeof original = []
  const prose = document.createElement('template')
  function flushProse() {
    const html = prose.innerHTML.trim()
    if (html) result.push({ html, smart: false })
    prose.content.replaceChildren()
  }
  for (const node of [...content.content.childNodes]) {
    if (node instanceof HTMLElement && node.matches('section.chat-smart-view')) {
      flushProse()
      result.push({ html: node.outerHTML, smart: true, stream: readSmartStream(node) })
    } else {
      prose.content.appendChild(node)
    }
  }
  flushProse()
  return result.some(block => block.smart) ? result : original
})

const messageContent = ref<HTMLElement>()
const chartSlots = new Map<HTMLElement, () => void>()
watch([messageContent, blocks], async (_, __, onCleanup) => {
  const slots = new Set(messageContent.value?.querySelectorAll<HTMLElement>('.chat-smart-layout-view figure[data-smart-chart]'))
  for (const [slot, dispose] of chartSlots) {
    if (slots.has(slot)) continue
    dispose()
    chartSlots.delete(slot)
  }
  if ([...slots].every(slot => chartSlots.has(slot))) return
  let cancelled = false
  onCleanup(() => { cancelled = true })
  const { mountSmartChart } = await import('./chatSmartChart')
  if (cancelled) return
  for (const slot of slots) {
    if (!chartSlots.has(slot)) chartSlots.set(slot, mountSmartChart(slot))
  }
}, { flush: 'post' })
onBeforeUnmount(() => chartSlots.forEach(dispose => dispose()))

watch([messageContent, blocks], (_, __, onCleanup) => {
  const root = messageContent.value
  root?.querySelectorAll<HTMLInputElement>('input:is([data-smart-slider], [data-smart-input], [data-smart-checklist])')
    .forEach(updateSmartViewControl)
  const slots = root?.querySelectorAll<HTMLElement>('.chat-smart-layout-view [data-smart-icon]')
  for (const slot of slots ?? []) {
    const icon = smartViewIcons.get(slot.dataset.smartIcon ?? '')
    if (icon) render(h(Icon, { name: icon, size: 15 }), slot)
  }
  onCleanup(() => slots?.forEach(slot => render(null, slot)))
}, { flush: 'post' })

watch([messageContent, blocks], (_, __, onCleanup) => {
  const slots = messageContent.value?.querySelectorAll<HTMLElement>(
    '.chat-smart-layout-view figure[data-smart-chart] > details > summary > [data-smart-chart-chevron]',
  )
  const disposers: (() => void)[] = []
  for (const slot of slots ?? []) {
    const details = slot.closest('details')
    if (!details) continue
    const update = () => render(h(FlipChevron, { open: details.open }), slot)
    update()
    details.addEventListener('toggle', update)
    disposers.push(() => {
      details.removeEventListener('toggle', update)
      render(null, slot)
    })
  }
  onCleanup(() => disposers.forEach(dispose => dispose()))
}, { flush: 'post' })

function onSmartInput(event: Event) {
  if (event.target instanceof HTMLInputElement) updateSmartViewControl(event.target)
}

const active = shallowRef<{ anchor: HTMLAnchorElement; sources: ChatSource[] }>()
const card = ref<HTMLElement>()
const previewZ = ref(0)
const index = ref(0)
const source = computed(() => active.value?.sources[index.value])
const position = ref<{ left: string; top: string; visibility?: 'hidden' }>({ left: '0px', top: '0px', visibility: 'hidden' })
let openTimer: ReturnType<typeof setTimeout> | undefined
let closeTimer: ReturnType<typeof setTimeout> | undefined
function cancelOpen() { clearTimeout(openTimer) }
function cancelClose() { clearTimeout(closeTimer) }
function close() {
  cancelOpen()
  cancelClose()
  active.value = undefined
}
function scheduleClose() {
  cancelClose()
  closeTimer = setTimeout(() => {
    if (!card.value?.contains(document.activeElement)) close()
  }, 180)
}

function citation(target: EventTarget | null) {
  const anchor = target instanceof Element ? target.closest<HTMLAnchorElement>('a.chat-source-pill[data-chat-source]') : null
  const sources = anchor && decorated.value.groups[Number(anchor.dataset.chatSource)]
  return anchor && sources ? { anchor, sources } : undefined
}
function updatePosition() {
  const target = active.value?.anchor
  const panel = card.value
  if (!target?.isConnected || !panel) return
  const rect = target.getBoundingClientRect()
  const { width, height } = panel.getBoundingClientRect()
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
  const below = rect.bottom + 6
  const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, rect.top - height - 6)
  position.value = { left: `${left}px`, top: `${top}px` }
}
async function open(entry: NonNullable<ReturnType<typeof citation>>, focus = false) {
  cancelOpen()
  cancelClose()
  if (active.value?.anchor !== entry.anchor) {
    position.value = { left: '0px', top: '0px', visibility: 'hidden' }
    index.value = 0
    previewZ.value = nextZ()
    active.value = entry
  }
  await nextTick()
  if (active.value?.anchor !== entry.anchor) return
  updatePosition()
  if (focus) card.value?.focus()
}
function onHover(event: PointerEvent) {
  if (event.pointerType === 'touch') return
  const entry = citation(event.target)
  if (!entry || entry.anchor.contains(event.relatedTarget as Node | null)) return
  cancelOpen()
  cancelClose()
  openTimer = setTimeout(() => { void open(entry) }, 200)
}
function onPointerOut(event: PointerEvent) {
  const entry = citation(event.target)
  if (!entry || entry.anchor.contains(event.relatedTarget as Node | null)) return
  cancelOpen()
  scheduleClose()
}
function onFocus(event: FocusEvent) {
  const entry = citation(event.target)
  if (entry) void open(entry)
}
function onClick(event: MouseEvent) {
  const entry = citation(event.target)
  if (!entry) return
  if (entry.sources.length === 1 && !(event instanceof PointerEvent && event.pointerType === 'touch')) return
  event.preventDefault()
  void open(entry, true)
}
function step(delta: number) {
  if (!active.value) return
  index.value = Math.min(active.value.sources.length - 1, Math.max(0, index.value + delta))
  void nextTick(updatePosition)
}
function onEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !active.value) return
  event.stopPropagation()
  const anchor = active.value.anchor
  if (card.value?.contains(document.activeElement)) anchor.focus()
  close()
}
function onScroll(event: Event) {
  if (active.value && !(event.target instanceof Node && card.value?.contains(event.target))) close()
}
function onOutsideClick(event: PointerEvent) {
  const target = event.target
  if (target instanceof Node && !active.value?.anchor.contains(target) && !card.value?.contains(target)) close()
}
watch(decorated, close)
watch(active, (entry, _previous, onCleanup) => {
  if (!entry) return
  const unregisterPopover = registerPopover(z => { previewZ.value = z })
  window.addEventListener('keydown', onEscape, true)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', close)
  window.addEventListener('pointerdown', onOutsideClick)
  onCleanup(() => {
    unregisterPopover()
    window.removeEventListener('keydown', onEscape, true)
    window.removeEventListener('scroll', onScroll, true)
    window.removeEventListener('resize', close)
    window.removeEventListener('pointerdown', onOutsideClick)
  })
})
onBeforeUnmount(close)
</script>

<style scoped>
.chat-assistant-content :deep(.md-view a.chat-source-pill) {
  display: inline-flex; align-items: center; gap: 0.35em;
  max-width: min(100%, 12em); box-sizing: border-box; padding: 0.08em 0.62em; margin-inline-start: 0.25em;
  border: 1px solid var(--action-outline); border-radius: var(--radius-pill);
  background: var(--action-soft); color: var(--content-primary);
  font-size: 0.85em; font-weight: 500; line-height: 1.55; vertical-align: middle; text-decoration: none;
  transition: background-color var(--motion-hover-control), border-color var(--motion-hover-control);
}
.chat-assistant-content :deep(.md-view a.chat-source-pill:is(:hover, :focus-visible)) {
  background: var(--action-soft-hover); border-color: var(--action-primary); opacity: 1;
}
.chat-assistant-content :deep(.md-view .chat-source-icon), .chat-source-icon {
  display: inline-grid; place-items: center; flex: none; inline-size: 1em; block-size: 1em;
}
.chat-assistant-content :deep(.md-view .chat-source-icon::before), .chat-source-icon::before {
  content: ''; grid-area: 1 / 1; inline-size: 100%; block-size: 100%; background: currentColor;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='M10 13.5l4-4m-6 6l-1 1a3 3 0 0 1-4-4l4-4a3 3 0 0 1 4 0m5 0l1-1a3 3 0 0 1 4 4l-4 4a3 3 0 0 1-4 0'/%3E%3C/svg%3E") center / contain no-repeat;
}
.chat-assistant-content :deep(.md-view .chat-source-icon:has(img.is-loaded)::before), .chat-source-icon:has(img.is-loaded)::before { visibility: hidden; }
.chat-assistant-content :deep(.md-view .chat-source-icon img), .chat-source-icon img {
  grid-area: 1 / 1; inline-size: 100%; block-size: 100%; margin: 0; border-radius: 0;
  object-fit: contain; visibility: hidden;
}
.chat-assistant-content :deep(.md-view .chat-source-icon img.is-loaded), .chat-source-icon img.is-loaded { visibility: visible; }
.chat-assistant-content :deep(.md-view .chat-source-title) { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.chat-assistant-content :deep(.md-view .chat-source-count) { flex: none; color: var(--content-secondary); }
.chat-citation-preview {
  position: fixed;
  box-sizing: border-box; width: min(320px, calc(100vw - 16px)); max-height: calc(100dvh - 16px); overflow: auto;
  display: grid; gap: 6px; padding: 12px;
  border: 1px solid var(--popup-surface-border); border-radius: var(--popup-surface-radius);
  background: var(--popup-surface-bg); box-shadow: var(--popup-surface-shadow); color: var(--content-primary);
  backdrop-filter: var(--popup-surface-blur); font-size: var(--font-size-sm); line-height: 1.5; overflow-wrap: anywhere;
}
.chat-citation-preview a { color: inherit; text-decoration: none; }
.chat-citation-preview a:hover { text-decoration: underline; }
.chat-citation-preview p, .citation-site, .citation-date, .citation-controls { color: var(--content-secondary); font-size: var(--font-size-xs); }
.citation-site { display: flex; align-items: center; gap: 0.4em; }
.chat-citation-preview p { margin: 0; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
.citation-controls { display: flex; align-items: center; gap: 4px; }
.citation-controls span { margin-inline-start: auto; }
.citation-controls button { padding: 2px 6px; border: 0; border-radius: var(--radius-xs); background: transparent; color: inherit; cursor: pointer; }
.citation-controls button:disabled { opacity: 0.45; cursor: default; }
.citation-controls button:hover:not(:disabled) { background: var(--surface-soft-hover); }
.citation-preview-enter-active, .citation-preview-leave-active { transition: opacity var(--motion-hover-control) var(--motion-ease-standard); }
.citation-preview-enter-from, .citation-preview-leave-to { opacity: 0; }
</style>
