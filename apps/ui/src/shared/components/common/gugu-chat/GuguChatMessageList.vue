<template>
  <!-- 单一消息列表：真虚拟列表（@tanstack/vue-virtual），任何时刻只挂载视口 ± overscan
       内的消息 DOM，其余用下面这段按测量/估算高度撑出来的占位空间代替，滚动条始终代表
       整个会话的真实长度。messagesEl 是真实可滚动容器，虚拟列表只管它内部挂多少 DOM。 -->
  <div class="chat-message-viewport">
  <div class="chat-messages" :class="{ 'is-session-settling': sessionSettling }" ref="messagesEl" @scroll.passive="updateScrollPosition" @pointerdown.capture="onSelectionPointerDown">
    <div v-if="historyState?.hasMore && nearHistoryTop && !sessionSettling" class="chat-history-status">
      <button type="button" :disabled="historyState.loading" @click="onLoadHistory?.()">
        {{ t(historyState.loading ? 'chatUi.loadingEarlier' : historyState.error ? 'chatUi.loadEarlierFailed' : 'chatUi.loadEarlier') }}
      </button>
    </div>
    <div class="msg-virtual-spacer" :style="{ height: virtualTotalSize + 'px' }">
      <!-- v-memo：同一帧内其它消息在变（比如正在流式输出的那条）时，跳过这一行没变的
           子树重新生成——虚拟列表已经把同时挂载的行数摁在个位数附近，这里收益比之前小，
           但仍能省掉一趟不必要的 vnode diff。 -->
      <div v-for="{ row, msg, messageIndex, tools, timestamp } in rowsWithMsg" :key="String(row.key)" :data-index="row.index"
           :data-message-id="String(msg.id)" :ref="measureRow"
           :class="['msg-virtual-row', { 'is-tool-row': msg.role === 'tool', 'is-interaction-row': msg.role === 'interaction' }]"
           :style="{ transform: `translateY(${row.start}px)` }">
        <div v-if="tools">
          <GuguChatToolActivity
            class="msg tool" :data-db-id="msg.dbId || ''" :tools="tools" :session-id="sessionId"
            :expanded="expandedActivityIds.has(msg.id)" :expanded-tools="expandedToolMessageIds"
            :awaiting-reply="streaming && row.index === projection.openGroupIndex"
            @toggle="toggleActivity(msg.id)" @detail="setToolExpanded"
          />
        </div>
        <div v-else :class="['msg', msg.role]" :data-db-id="msg.dbId || ''"
           v-memo="[timestamp, msg.role, msg.speakerLabel, msg.text, msg.html, msg.streaming, messageIndex < messages.length - 1, msg.references, msg.roundId, msg.runOutcome, msg.linkButtons, sourceByMessage.get(msg.id), msg.interaction?.resolved, msg.interaction?.expired, msg.interaction?.selectedOptionId, msg.interaction?.selectedOptionIds, msg.interaction?.customAnswer, msg.interaction?.selectionMode, msg.interaction?.allowTextInput, msg.interaction?.customInputActive, msg.interaction?.taskPaused, msg.interaction?.submitting, msg.interaction?.responseText, msg.interaction?.secretFields, interactionAnswerMode, msg.files?.length, msg.files?.map(f => `${f.file_id ?? ''}:${f.attach_id ?? ''}:${f.ext ?? ''}:${f.transcript ?? ''}:${f.transcript_status ?? ''}:${f.transcript_origin ?? ''}`).join(','), msg.quotedText, copiedId === msg.id, voicePlayingId && msg.files?.some(f => f.attach_id === voicePlayingId), voicePlayingId && msg.files?.some(f => f.attach_id === voicePlayingId) ? voiceBars.join(',') : '']">
          <GuguChatMessageRow
            :msg="msg" :timestamp="timestamp" :sources="sourceByMessage.get(msg.id)" :has-following-message="messageIndex < messages.length - 1" :session-id="sessionId" :is-group-session="isGroupSession" :interaction-answer-mode="interactionAnswerMode"
            :copied-id="copiedId" :voice-playing-id="voicePlayingId" :voice-bars="voiceBars"
            @copy="$emit('copy', $event)" @toggle-voice="$emit('toggleVoice', $event)"
            @open-file="$emit('openFile', $event)" @download="$emit('download', $event)" @action-click="$emit('actionClick', $event)"
            @interaction-select="(selectedMsg, option) => $emit('interactionSelect', selectedMsg, option)"
            @interaction-text-submit="(selectedMsg, text) => $emit('interactionTextSubmit', selectedMsg, text)"
            @secret-submit="(selectedMsg, values) => $emit('secretSubmit', selectedMsg, values)"
            @secret-cancel="selectedMsg => $emit('secretCancel', selectedMsg)"
            @reference-click="$emit('referenceClick', $event)"
          />
        </div>
      </div>
    </div>
    <div v-if="statusKind && !(streaming && projection.openGroupIndex !== undefined)" class="chat-generation-status">
      <GuguChatActivityLine :label="statusTyped || t('chatUi.preparingReply')"
        :indicator="statusKind === 'dots' ? 'dots' : 'running'" />
    </div>
  </div>
    <Transition name="chat-scroll-to-bottom-fade">
      <button
        v-if="showScrollToBottom"
        class="chat-scroll-to-bottom"
        type="button"
        :aria-label="t('chatUi.scrollToLatest')"
        :title="t('chatUi.scrollToLatest')"
        @click="scrollToBottom('smooth')"
      >
        <Icon name="action.skip-down" :size="20" />
      </button>
    </Transition>
  </div>
</template>

<script setup lang="ts">
/**
 * 虚拟列表、滚动容器和消息行排列的唯一所有权：真实可滚动 DOM（messagesEl）、
 * @tanstack/vue-virtual 实例和逐行测量都收在这里。不拥有发送请求或消息数据本身——
 * messages 由 GuguChat.vue 持有并作为 prop 传入，这里只读取展示、不重新赋值整个数组
 * （html 懒渲染回填除外：那是纯展示缓存，不是业务字段）。
 *
 * 父组件仍需要拿到真实滚动容器（scrollTop/scrollHeight/addEventListener）和
 * virtualizer 的 scrollToIndex（流式跟随滚动、切会话定位、搜索跳转高亮），
 * 通过 defineExpose 暴露 el 和 scrollToIndex，不把这些操作重新实现一遍。
 */
import type { ChatHistoryState } from './composables/useChatHistoryPagination'
import type { SessionScrollAnchor } from './composables/sessionScrollLayout'
import { ref, computed, watch, watchEffect, nextTick, onMounted, onUnmounted, type ComponentPublicInstance } from 'vue'
import { useI18n } from 'vue-i18n'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/vue-virtual'
import GuguChatActivityLine from './GuguChatActivityLine.vue'
import GuguChatToolActivity from './GuguChatToolActivity.vue'
import { useChatSources } from './useChatSources'
import type { ChatSource } from './chatSources'
import { projectChatRows } from './toolActivity'
import GuguChatMessageRow from './GuguChatMessageRow.vue'
import Icon from '@/components/common/icons/Icon.vue'
import type { ChatMessage, ChatFile, ChatReference, InteractionAnswerMode } from './chatTypes'
import { renderMd } from './markdown'

const props = defineProps<{
  messages: ChatMessage[]
  sessionId: number | null
  isGroupSession: boolean
  interactionAnswerMode: InteractionAnswerMode
  copiedId: number | null
  voicePlayingId: string | null
  voiceBars: number[]
  expanded: boolean
  resizing: boolean
  streaming: boolean
  statusKind: string
  statusTyped: string
  historyState?: ChatHistoryState
  onLoadHistory?: () => void
  sessionSettling: boolean
}>()

defineEmits<{
  copy: [msg: ChatMessage]
  toggleVoice: [file: ChatFile]
  openFile: [file: ChatFile]
  download: [file: ChatFile]
  actionClick: [e: MouseEvent]
  interactionSelect: [msg: ChatMessage, option: { id: string; label: string; token: string; selectedOptionIds?: string[]; customAnswer?: string }]
  interactionTextSubmit: [msg: ChatMessage, text: string]
  secretSubmit: [msg: ChatMessage, values: Record<string, string>]
  secretCancel: [msg: ChatMessage]
  referenceClick: [reference: ChatReference]
}>()

const { t } = useI18n()
const messagesEl = ref<HTMLElement | null>(null)
const showScrollToBottom = ref(false)
const SCROLL_TO_BOTTOM_THRESHOLD = 240
const expandedToolMessageIds = ref(new Set<string>())
const expandedActivityIds = ref(new Set<number>())
function toggleActivity(id: number) {
  if (expandedActivityIds.value.has(id)) expandedActivityIds.value.delete(id)
  else expandedActivityIds.value.add(id)
}
const projection = computed(() => projectChatRows(props.messages))
const selectionActive = ref(false)
const pinnedSelectionIds = ref<{ anchorId: string; focusId: string } | null>(null)
const messageIndexById = computed(() => new Map(props.messages.map((message, index) => [String(message.id), projection.value.rowIndexByMessageIndex[index]!])))

function setToolExpanded(messageId: number, expanded: boolean) {
  const id = String(messageId)
  const next = new Set(expandedToolMessageIds.value)
  if (expanded) next.add(id)
  else next.delete(id)
  expandedToolMessageIds.value = next
}

function rowMessageId(node: Node | null): string | null {
  const element = node instanceof Element ? node : node?.parentElement
  const row = element?.closest<HTMLElement>('.msg-virtual-row')
  if (!row || !messagesEl.value?.contains(row)) return null
  return row.dataset.messageId || null
}

function onSelectionPointerDown(event: PointerEvent) {
  if (!event.isPrimary || event.button !== 0) return
  const target = event.target instanceof Element ? event.target : null
  if (!target || target.closest('button, a, input, textarea, select, [contenteditable="true"]')) return
  if (!target.closest('.msg-bubble, .tool-detail-shell')) return
  const messageId = rowMessageId(target)
  if (!messageId) return
  selectionActive.value = true
  pinnedSelectionIds.value = { anchorId: messageId, focusId: messageId }
}

function syncPinnedSelection() {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed) {
    if (!selectionActive.value) pinnedSelectionIds.value = null
    return
  }
  const anchorId = rowMessageId(selection.anchorNode)
  const focusId = rowMessageId(selection.focusNode)
  if (anchorId && focusId) pinnedSelectionIds.value = { anchorId, focusId }
  else if (!selectionActive.value) pinnedSelectionIds.value = null
}

function onSelectionPointerEnd() {
  selectionActive.value = false
  syncPinnedSelection()
}

function onSelectionPointerCancel() {
  selectionActive.value = false
  pinnedSelectionIds.value = null
}

function updateScrollPosition() {
  const element = messagesEl.value
  if (!element) {
    showScrollToBottom.value = false
    return
  }
  // 虚拟列表的占位总高是滚动内容的权威尺寸；避免 DOM scrollHeight 在测量/重排期间滞后，
  // 导致用户已经滚离底部但按钮仍被判断为隐藏。
  const distanceFromBottom = virtualizer.value.getTotalSize() - element.scrollTop - element.clientHeight
  showScrollToBottom.value = distanceFromBottom > SCROLL_TO_BOTTOM_THRESHOLD
}

function scrollToBottom(behavior: 'auto' | 'smooth' = 'auto') {
  const lastRow = projection.value.rows.length - 1
  if (!messagesEl.value || lastRow < 0) return
  virtualizer.value.scrollToIndex(lastRow, { align: 'end', behavior })
}

// 消息高度不定长（纯文本/代码块/文件卡片/语音条差异很大），measureElement 首次挂载
// 后用真实高度回填、并自带 ResizeObserver 持续纠偏（图片/缩略图迟一拍加载导致变高也能跟上）。
const msgsPadTop = computed(() => props.expanded ? 20 : 12)
const virtualizer = useVirtualizer({
  get paddingStart() { return msgsPadTop.value },
  get count() { return projection.value.rows.length },
  // 复用虚拟库的稳定 key 锚定，插入旧页时保留当前消息及其视口内偏移。
  get anchorTo() { return props.resizing ? 'start' as const : 'end' as const },
  followOnAppend: false,
  getScrollElement: () => messagesEl.value,
  estimateSize: () => 96,
  // 前后各多挂载 10 条，覆盖快速滚动时的缓冲区；Mermaid 首次计算会由共享 LRU 缓存复用。
  overscan: 10,
  // 原生文本选区跨多屏时，保留锚点到当前端点之间的全部行；选区清空后恢复普通窗口。
  rangeExtractor: (range) => {
    const visibleIndices = defaultRangeExtractor(range)
    const pinned = pinnedSelectionIds.value
    if (!pinned || visibleIndices.length === 0) return visibleIndices
    const anchorIndex = messageIndexById.value.get(pinned.anchorId)
    const focusIndex = messageIndexById.value.get(pinned.focusId)
    if (anchorIndex == null || focusIndex == null) return visibleIndices
    const start = Math.min(visibleIndices[0], anchorIndex, focusIndex)
    const end = Math.max(visibleIndices[visibleIndices.length - 1], anchorIndex, focusIndex)
    return Array.from({ length: end - start + 1 }, (_, offset) => start + offset)
  },
  // 虚拟行 key 必须唯一对应一个展示气泡。一个持久化助手消息可能展开为多个
  // timeline 气泡，共享 dbId；优先使用前端气泡 id，避免 key 冲突和测量高度串行。
  getItemKey: (index) => {
    const message = projection.value.rows[index]?.msg
    return message?.id ?? message?.dbId ?? `${props.sessionId ?? 'new'}:${index}`
  },
})
// 只补偿完全位于视口上方的行；跨越顶部的长消息变高不应推动正在阅读的内容。
// 上翻时新挂载行与 Markdown 异步变高共用此规则，避免首次测量按整条高度误补偿。
// 尺寸过渡由窗口域维护视口底部锚点，避免虚拟列表同时纠偏。
watchEffect(() => {
  virtualizer.value.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    !props.resizing && item.end <= (instance.scrollElement?.scrollTop ?? instance.scrollOffset ?? 0)
})
const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const nearHistoryTop = computed(() => (virtualRows.value[0]?.index ?? 0) <= 10)
// 绝对定位的子元素不会跟着祖先的 padding 走（top:0/left:0 是相对祖先的边框盒，不是内容盒），
// 顶部留白交给 virtualizer 的 paddingStart，让测量、滚动定位和视觉位置使用同一坐标。
// 水平方向留白仍由每一行负责。
const virtualTotalSize = computed(() => virtualizer.value.getTotalSize())
// v-for 需要同时拿到虚拟行的定位信息（row）和它对应的消息（msg），zip 成一个数组，
// 这样消息行内部的模板完全不用改，照样按 msg.xxx 取值。
const rowsWithMsg = computed(() => virtualRows.value.flatMap(row => {
  const projected = projection.value.rows[row.index]
  if (!projected) return []
  const { msg, messageIndex, tools } = projected
  const timestamp = tools ? undefined : msg.time
  return [{ row, msg, messageIndex, tools, timestamp }]
}))
const visibleChatMessages = computed(() => rowsWithMsg.value.map(row => row.msg))
const sourcesForMessage = useChatSources(() => props.sessionId, () => props.messages, () => visibleChatMessages.value)
const sourceByMessage = computed<Map<number, ChatSource[] | undefined>>(previous => new Map(rowsWithMsg.value
  .filter(row => row.msg.role === 'ai')
  .map(({ msg, messageIndex }) => {
    const sources = sourcesForMessage(msg, messageIndex)
    const existing = previous?.get(msg.id)
    return [msg.id, sources && existing?.length === sources.length && sources.every((source, index) => source === existing[index])
      ? existing : sources] as const
  })))

watch(() => props.sessionId, async () => {
  // 切换会话时清掉旧行的测量结果，等新会话行重新挂载后再测量。
  expandedToolMessageIds.value = new Set()
  expandedActivityIds.value = new Set()
  selectionActive.value = false
  pinnedSelectionIds.value = null
  await nextTick()
  virtualizer.value.measure()
  updateScrollPosition()
}, { flush: 'post' })
function measureRow(el: Element | ComponentPublicInstance | null) { if (el) virtualizer.value.measureElement(el as Element) }

onMounted(() => {
  document.addEventListener('selectionchange', syncPinnedSelection)
  window.addEventListener('pointerup', onSelectionPointerEnd)
  window.addEventListener('pointercancel', onSelectionPointerCancel)
  nextTick(updateScrollPosition)
})
onUnmounted(() => {
  document.removeEventListener('selectionchange', syncPinnedSelection)
  window.removeEventListener('pointerup', onSelectionPointerEnd)
  window.removeEventListener('pointercancel', onSelectionPointerCancel)
})

// 只有真正挂进视口 ± overscan 的消息才需要解析 markdown——不在 loadSession 时就把
// 整个历史一次性跑一遍 marked.parse，等消息第一次进虚拟窗口再补，减轻长会话打开时的
// 一次性 CPU 尖峰；已经解析过的（html 非空）不重复解析。
watch(virtualRows, (rows) => {
  for (const row of rows) {
    const m = projection.value.rows[row.index]?.msg
    if (m && m.role === 'ai' && !m.streaming && m.html == null) m.html = renderMd(m.text)
  }
})
watch([virtualTotalSize, () => props.messages.length], ([, count], [previousSize, previousCount]) => {
  const el = messagesEl.value
  // 行高更新与占位 DOM 在同一轮提交。只延续原本贴底的视口，新增消息走既有跟随流程。
  if (el && !props.resizing && !props.sessionSettling && count === previousCount
    && previousSize - el.scrollTop - el.clientHeight <= 2) {
    el.scrollTop = el.scrollHeight - el.clientHeight
  }
  updateScrollPosition()
}, { flush: 'post' })

function captureScrollAnchor(): SessionScrollAnchor | null {
  const el = messagesEl.value
  if (!el || !el.clientHeight || el.scrollHeight - el.scrollTop - el.clientHeight <= 2) return null
  const row = virtualRows.value.find(({ start, end, index }) =>
    end > el.scrollTop && start < el.scrollTop + el.clientHeight && projection.value.rows[index]?.msg._syncKey,
  )
  const messageKey = row && projection.value.rows[row.index]?.msg._syncKey
  return row && messageKey ? { messageKey, offset: el.scrollTop - row.start } : null
}

function restoreScrollAnchor(messageIndex: number, offset: number): boolean {
  const index = projection.value.rowIndexByMessageIndex[messageIndex]
  if (index === undefined) return false
  const el = messagesEl.value
  if (!el) return false
  const row = virtualRows.value.find(item => item.index === index)
  if (!row) {
    virtualizer.value.scrollToIndex(index, { align: 'start' })
    return true
  }
  // 消息更新后可能变短，滚动位置仍要留在锚点消息内。
  const target = Math.min(
    Math.max(0, row.start + Math.min(offset, Math.max(0, row.size - 1))),
    Math.max(0, el.scrollHeight - el.clientHeight),
  )
  if (Math.abs(target - el.scrollTop) <= 1) return false
  virtualizer.value.scrollToOffset(target)
  return true
}

defineExpose({
  el: computed(() => messagesEl.value),
  scrollToBottom,
  captureScrollAnchor,
  restoreScrollAnchor,
  getVirtualRangeStart: () => projection.value.rows[virtualRows.value[0]?.index ?? 0]?.messageIndex ?? 0,
  scrollToIndex: (idx: number, opts: Parameters<ReturnType<typeof useVirtualizer>['value']['scrollToIndex']>[1]) =>
    virtualizer.value.scrollToIndex(projection.value.rowIndexByMessageIndex[idx] ?? idx, opts),
})
</script>

<style scoped>
/* 高度修正仅由虚拟列表负责，避免浏览器自动锚定再次补偿同一变化。 */
.chat-message-viewport { position: relative; display: flex; flex: 1; min-height: 0; min-width: 0; }
.chat-messages { overflow-anchor: none; }
.chat-history-status { position: sticky; top: 0; height: 0; z-index: 1; text-align: center; }
.chat-history-status button { position: relative; margin-top: var(--space-xs); padding: var(--space-xs) var(--space-sm); border: 1px solid var(--input-border); border-radius: var(--radius-sm); background: var(--surface-base); color: var(--text-secondary); font: inherit; cursor: pointer; }
.chat-scroll-to-bottom {
  --scroll-button-glass: color-mix(in srgb, var(--popup-surface-bg) 82%, transparent);
  position: absolute; left: 50%; bottom: 16px; z-index: 2;
  display: grid; place-items: center; width: 32px; height: 32px; padding: 0;
  border: 1px solid var(--popup-surface-border); border-radius: 50%;
  background: var(--scroll-button-glass); color: var(--action-primary);
  backdrop-filter: var(--popup-surface-blur);
  -webkit-backdrop-filter: var(--popup-surface-blur);
  box-shadow: var(--popup-surface-shadow); cursor: pointer;
  transform: translateX(-50%);
  transition: background-color var(--motion-hover-control) var(--motion-ease-standard), transform var(--motion-hover-control) var(--motion-ease-standard);
}
.chat-scroll-to-bottom:hover { background: color-mix(in srgb, var(--scroll-button-glass), var(--action-primary) 5%); }
.chat-scroll-to-bottom:active { transform: translate(-50%, 1px); }
.chat-scroll-to-bottom:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
.chat-scroll-to-bottom-fade-enter-active,
.chat-scroll-to-bottom-fade-leave-active { transition: opacity var(--motion-hover-control) var(--motion-ease-standard); }
.chat-scroll-to-bottom-fade-enter-from,
.chat-scroll-to-bottom-fade-leave-to { opacity: 0; }
</style>
