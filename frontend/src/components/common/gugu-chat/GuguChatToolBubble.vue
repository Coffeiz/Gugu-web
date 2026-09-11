<template>
  <div class="tool-event-bubble">
    <button class="tool-event-head" type="button" :aria-expanded="expanded" @click="expanded = !expanded">
      <span class="tool-event-state" :class="`is-${msg.toolStatus || 'running'}`" aria-hidden="true" />
      <span class="tool-event-label">{{ toolLabel }}</span>
      <span class="tool-event-meta">{{ statusText }}</span>
      <span v-if="durationText" class="tool-event-duration">{{ durationText }}</span>
      <FlipChevron :open="expanded" :size="10" :transition="'transform var(--motion-hover-card) var(--motion-ease-emphasis)'" aria-hidden="true" />
    </button>
    <Transition
      :css="false"
      @before-enter="prepareDetailEnter"
      @enter="animateDetailEnter"
      @after-enter="cleanupDetailTransition"
      @enter-cancelled="cancelDetailTransition"
      @before-leave="prepareDetailLeave"
      @leave="animateDetailLeave"
      @after-leave="cleanupDetailTransition"
      @leave-cancelled="cancelDetailTransition"
    >
      <div v-if="expanded" class="tool-detail-shell">
        <div class="tool-event-detail">
          <div v-if="msg.toolInput !== undefined" class="tool-event-section">
            <span class="tool-event-caption">{{ t('chatUi.input') }}</span>
            <pre>{{ formatValue(msg.toolInput) }}</pre>
          </div>
          <div v-if="msg.toolResult !== undefined" class="tool-event-section">
            <span class="tool-event-caption">
              {{ t('chatUi.result') }}
              <span v-if="resultDisplayTruncated" class="tool-event-limit">{{ t('chatUi.outputDisplayLimited', { count: OUTPUT_DISPLAY_LIMIT.toLocaleString() }) }}</span>
            </span>
            <pre>{{ displayResult }}</pre>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
const { t, te } = useI18n()
import { computed, ref } from 'vue'
import FlipChevron from '@/components/common/controls/FlipChevron.vue'
import type { ChatMessage } from './chatTypes'

const props = defineProps<{ msg: ChatMessage }>()
const expanded = ref(false)
const OUTPUT_DISPLAY_LIMIT = 32_000
const resolvedToolName = computed(() => {
  if (props.msg.toolName !== 'call_tool' || !props.msg.toolInput || typeof props.msg.toolInput !== 'object') {
    return props.msg.toolName || ''
  }
  const target = (props.msg.toolInput as { name?: unknown }).name
  return typeof target === 'string' && target.trim() ? target.trim() : 'call_tool'
})
const toolLabel = computed(() => {
  const toolName = resolvedToolName.value
  const key = `toolNames.${toolName}`
  // 固定 Adapter 会把业务工具通过 call_tool 转发。旧事件的真实工具名在
  // toolInput.name 中；已知工具必须优先走当前语言，避免后端旧中文 label
  // 覆盖英文/日文翻译。
  const backendLabel = props.msg.toolLabel?.trim()
  if (toolName && te(key)) return t(key)
  return backendLabel || toolName || t('chatUi.toolCall')
})
const statusText = computed(() => ({
  running: t('chatUi.toolRunning'), waiting: t('chatUi.toolWaiting'), success: t('chatUi.toolDone'), error: t('chatUi.toolFailed'), skipped: t('chatUi.toolSkipped'),
  cancelled: t('chatUi.toolCancelled'),
}[props.msg.toolStatus || 'running']))
const durationText = computed(() => {
  if (props.msg.toolDurationMs == null || props.msg.toolDurationMs < 0) return ''
  const seconds = props.msg.toolDurationMs / 1000
  return seconds < 1 ? `${Math.round(props.msg.toolDurationMs)}ms` : `${seconds.toFixed(1)}s`
})
function formatValue(value: unknown) {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}
const formattedResult = computed(() => formatValue(props.msg.toolResult))
const resultDisplayTruncated = computed(() => formattedResult.value.length > OUTPUT_DISPLAY_LIMIT)
const displayResult = computed(() => resultDisplayTruncated.value
  ? `${formattedResult.value.slice(0, OUTPUT_DISPLAY_LIMIT)}\n…`
  : formattedResult.value)

const detailTransition = 'height var(--motion-hover-card) var(--motion-ease-emphasis)'
const detailTransitionCleanups = new WeakMap<HTMLElement, () => void>()

function prepareDetailEnter(element: Element) {
  const node = element as HTMLElement
  node.style.height = '0px'
  node.style.opacity = '1'
  node.style.overflow = 'hidden'
}

function prepareDetailLeave(element: Element) {
  const node = element as HTMLElement
  node.style.height = `${node.getBoundingClientRect().height}px`
  node.style.opacity = '1'
  node.style.overflow = 'hidden'
}

function animateDetail(element: Element, targetHeight: string, done: () => void) {
  const node = element as HTMLElement
  detailTransitionCleanups.get(node)?.()
  let finished = false
  let timer: number | undefined
  const finish = () => {
    if (finished) return
    finished = true
    node.removeEventListener('transitionend', onEnd)
    if (timer !== undefined) window.clearTimeout(timer)
    detailTransitionCleanups.delete(node)
    done()
  }
  const onEnd = (event: TransitionEvent) => {
    if (event.propertyName === 'height') finish()
  }
  node.addEventListener('transitionend', onEnd)
  node.style.transition = detailTransition
  requestAnimationFrame(() => {
    if (finished) return
    node.style.height = targetHeight
  })
  timer = window.setTimeout(finish, 380)
  detailTransitionCleanups.set(node, () => {
    if (finished) return
    finished = true
    node.removeEventListener('transitionend', onEnd)
    if (timer !== undefined) window.clearTimeout(timer)
    detailTransitionCleanups.delete(node)
  })
}

function animateDetailEnter(element: Element, done: () => void) {
  const node = element as HTMLElement
  animateDetail(node, `${node.scrollHeight}px`, done)
}

function animateDetailLeave(element: Element, done: () => void) {
  animateDetail(element, '0px', done)
}

function cancelDetailTransition(element: Element) {
  const node = element as HTMLElement
  detailTransitionCleanups.get(node)?.()
  cleanupDetailTransition(node)
}

function cleanupDetailTransition(element: Element) {
  const node = element as HTMLElement
  node.style.height = ''
  node.style.opacity = ''
  node.style.overflow = ''
  node.style.transition = ''
}
</script>

<style scoped>
.tool-event-bubble { position: relative; isolation: isolate; width: min(360px, 88%); margin: 0; border: 1px solid var(--border-default); border-radius: var(--card-radius); background-color: var(--gugu-chat-assistant-bg); color: var(--content-secondary); box-shadow: var(--elevation-card); overflow: hidden; transition: border-color var(--motion-hover-card) var(--motion-ease-standard), box-shadow var(--motion-hover-card) var(--motion-ease-standard); }
/* hover 高亮独立成 opacity 层：展开详情会改变父卡片高度，不能让背景色插值和这次重排互相打断。 */
.tool-event-bubble::after { content: ''; position: absolute; inset: 0; z-index: 0; pointer-events: none; border-radius: inherit; background-color: var(--gugu-chat-tool-bubble-hover); opacity: 0; transition: opacity var(--motion-hover-card) var(--motion-ease-standard); }
/* hover 底色走专用 token：亮色=主题玻璃 hover（白系提亮），暗色=气泡底色向白偏移
   （通用 --surface-glass-hover 在暗色是透明白叠层，透出页面暗底反而更暗，实测翻车）。
   这里只响应真实鼠标 hover；不要用 focus-within 模拟 hover，否则点击标题按钮后
   按钮持续获得焦点，卡片会一直停留在 hover 外观，直到点击空白处。键盘焦点仍由
   .tool-event-head:focus-visible 提供明确的焦点反馈。 */
.tool-event-bubble:hover { border-color: var(--border-hover); box-shadow: var(--elevation-card-hover); }
.tool-event-bubble:hover::after { opacity: 1; }
.tool-event-head { position: relative; z-index: 1; display: grid; grid-template-columns: 8px minmax(0, 1fr) auto auto; grid-template-rows: auto auto; align-items: center; column-gap: 9px; width: 100%; min-height: 54px; border: 0; padding: 10px 12px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.tool-event-head:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--border-focus); }
.tool-event-state { grid-row: 1 / span 2; width: 8px; height: 8px; border-radius: var(--radius-pill); background: var(--content-tertiary); }
.tool-event-state.is-running { background: var(--action-primary); animation: tool-pulse 1.2s ease-in-out infinite; }
.tool-event-state.is-success { background: var(--status-success); }
.tool-event-state.is-error { background: var(--status-danger); }
.tool-event-state.is-skipped { background: var(--status-warning); }
.tool-event-state.is-cancelled { background: var(--content-tertiary); }
.tool-event-label { min-width: 0; color: var(--content-primary); font-size: var(--font-size-sm); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-event-meta { grid-column: 2; grid-row: 2; color: var(--content-secondary); font-size: var(--font-size-xs); white-space: nowrap; }
.tool-event-duration { grid-column: 3; grid-row: 1 / span 2; align-self: center; color: var(--content-tertiary); font-size: var(--font-size-xs); white-space: nowrap; }
.tool-event-head :deep(.flip-chevron) { grid-column: 4; grid-row: 1 / span 2; align-self: center; }
.tool-event-detail { position: relative; z-index: 1; padding: 10px 12px 11px; border-top: 1px solid var(--panel-divider); background: transparent; color: var(--content-secondary); }
.tool-event-section + .tool-event-section { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--panel-divider); }
.tool-event-caption { display: block; margin-bottom: 4px; color: var(--content-tertiary); font-size: var(--font-size-xs); font-weight: 600; }
.tool-event-limit { margin-left: 6px; color: var(--content-tertiary); font-weight: 400; }
pre { max-height: 180px; margin: 0; overflow: auto; color: var(--content-primary); white-space: pre-wrap; word-break: break-word; font: var(--font-size-xs)/var(--line-height-body) var(--font-family-mono); }
.tool-detail-shell { min-height: 0; overflow: hidden; }
.tool-detail-shell > .tool-event-detail { min-height: 0; overflow: hidden; }
@keyframes tool-pulse { 50% { opacity: .35; } }
</style>
