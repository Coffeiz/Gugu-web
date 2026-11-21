<template>
  <div class="tool-detail-row">
    <button class="tool-event-head" type="button" :aria-expanded="expanded" :aria-busy="detailsLoading && expandRequested" @click="toggleExpanded">
      <span class="tool-event-state" :class="`is-${msg.toolStatus || 'running'}`" aria-hidden="true" />
      <span class="tool-event-label" :title="toolLabel">{{ toolLabel }}</span>
      <span class="tool-event-meta" :class="{ 'is-error': detailsError }" aria-live="polite">{{ headerStatusText }}</span>
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
          <div v-if="detailsLoading && msg.toolInput === undefined && msg.toolResult === undefined" class="tool-event-section tool-details-loading" role="status">
            {{ t('chatUi.loadingToolDetails') }}
          </div>
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
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue'
import FlipChevron from '@/components/common/controls/FlipChevron.vue'
import type { ChatMessage } from './chatTypes'
import { agentApi } from '@/services/api'
import { chatToolDetailsKey } from './chatPresentationAccess'
import { toolActivityLabel } from './toolActivity'

const readToolDetails = inject(chatToolDetailsKey, agentApi.getToolEventDetails)

const props = defineProps<{ msg: ChatMessage; sessionId: number | null; expanded: boolean }>()
const emit = defineEmits<{ 'update:expanded': [expanded: boolean] }>()
const detailsLoading = ref(false)
const detailsError = ref(false)
const expandRequested = ref(false)
let requestGeneration = 0

function resetDetailsRequest() {
  requestGeneration += 1
  expandRequested.value = false
  detailsLoading.value = false
  detailsError.value = false
}
watch(() => [props.msg, props.sessionId, props.expanded], () => {
  resetDetailsRequest()
  if (props.expanded && needsDetails()) void loadDetails()
}, { immediate: true })
onBeforeUnmount(resetDetailsRequest)
const OUTPUT_DISPLAY_LIMIT = 32_000
const toolLabel = computed(() => toolActivityLabel(props.msg, t, te))
const statusText = computed(() => ({
  queued: t('chatUi.toolQueued'), running: t('chatUi.toolRunning'), waiting: t('chatUi.toolWaiting'), success: t('chatUi.toolDone'), error: t('chatUi.toolFailed'), skipped: t('chatUi.toolSkipped'),
  cancelled: t('chatUi.toolCancelled'), stopped: t('chatUi.toolStopped'), unknown: t('chatUi.toolResultUnknown'),
}[props.msg.toolStatus || 'running']))
const headerStatusText = computed(() => {
  if (detailsError.value) return `${t('chatUi.loadToolDetailsFailed')} · ${t('chatUi.retryToolDetails')}`
  if (detailsLoading.value && expandRequested.value) return t('chatUi.loadingToolDetails')
  return statusText.value
})
const runningSince = computed(() => props.msg.toolStatus === 'running'
  ? Date.parse(props.msg.toolStartedAt ?? '')
  : NaN)
const durationNow = ref(Date.now())
watch(runningSince, (since, _previous, onCleanup) => {
  if (!Number.isFinite(since)) return
  durationNow.value = Date.now()
  const timer = window.setInterval(() => { durationNow.value = Date.now() }, 250)
  onCleanup(() => window.clearInterval(timer))
}, { immediate: true })
const durationText = computed(() => {
  const elapsed = Number.isFinite(runningSince.value)
    ? (props.msg.toolDurationMs ?? 0) + Math.max(0, durationNow.value - runningSince.value)
    : props.msg.toolDurationMs
  if (elapsed == null || !Number.isFinite(elapsed) || elapsed < 0) return ''
  return elapsed < 1000 ? `${Math.round(elapsed)}ms` : `${(elapsed / 1000).toFixed(1)}s`
})
function formatValue(value: unknown) {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}
function needsDetails() {
  const { msg, sessionId } = props
  return Boolean(msg.toolDetailsAvailable && !msg._toolDetailsLoaded
    && msg.toolInput === undefined && msg.toolResult === undefined
    && msg._toolDetailsSource && sessionId != null)
}
const formattedResult = computed(() => formatValue(props.msg.toolResult))
const resultDisplayTruncated = computed(() => formattedResult.value.length > OUTPUT_DISPLAY_LIMIT)
const displayResult = computed(() => resultDisplayTruncated.value
  ? `${formattedResult.value.slice(0, OUTPUT_DISPLAY_LIMIT)}\n…`
  : formattedResult.value)

function toggleExpanded() {
  if (props.expanded) {
    emit('update:expanded', false)
    return
  }
  // 等待中再次点击只取消展开意图；请求结果仍可缓存，不能晚到后自动展开。
  if (expandRequested.value) {
    expandRequested.value = false
    return
  }
  expandRequested.value = true
  if (!needsDetails()) {
    expandRequested.value = false
    detailsError.value = false
    emit('update:expanded', true)
  } else if (!detailsLoading.value) {
    void loadDetails()
  }
}

async function loadDetails() {
  const { msg, sessionId } = props
  const source = msg._toolDetailsSource
  if (!source || sessionId == null) return
  const generation = requestGeneration
  detailsLoading.value = true
  detailsError.value = false
  try {
    const details = await readToolDetails(sessionId, source)
    if (generation !== requestGeneration) return
    if (Object.prototype.hasOwnProperty.call(details, 'toolInput')) msg.toolInput = details.toolInput
    if (Object.prototype.hasOwnProperty.call(details, 'toolResult')) msg.toolResult = details.toolResult
    msg._toolDetailsLoaded = true
    // 数据与展开状态在同一轮更新，动画第一次测量即得到完整详情高度。
    if (expandRequested.value) emit('update:expanded', true)
  } catch {
    if (generation === requestGeneration && (expandRequested.value || props.expanded)) detailsError.value = true
  } finally {
    if (generation === requestGeneration) {
      detailsLoading.value = false
      expandRequested.value = false
    }
  }
}

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
  // 行高变化由虚拟列表的底部锚点统一跟随。
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
.tool-detail-row { min-width: 0; }
.tool-event-head {
  display: grid; grid-template-columns: 7px minmax(0, 1fr) auto auto auto; align-items: center; gap: 7px;
  width: 100%; min-height: 30px; border: 0; padding: 4px 10px;
  background: transparent; color: inherit; text-align: left; cursor: pointer;
}
.tool-event-head:focus-visible { outline: 2px solid var(--border-focus); outline-offset: -2px; }
.tool-event-state { width: 6px; height: 6px; border-radius: var(--radius-pill); background: var(--content-tertiary); }
.tool-event-state.is-running { background: var(--action-primary); }
.tool-event-state.is-success { background: var(--status-success); }
.tool-event-state.is-error { background: var(--status-danger); }
.tool-event-state.is-waiting, .tool-event-state.is-skipped { background: var(--status-warning); }
.tool-event-label { color: var(--content-primary); font-size: var(--font-size-xs); overflow-wrap: anywhere; }
.tool-event-meta { color: var(--content-secondary); font-size: var(--font-size-xs); overflow-wrap: anywhere; }
.tool-event-meta.is-error { color: var(--status-danger); }
.tool-event-duration { color: var(--content-tertiary); font-size: var(--font-size-xs); white-space: nowrap; }
.tool-event-detail {
  margin: 4px 0 6px; padding: 9px 12px 10px;
  border: 1px solid var(--border-document-table); border-radius: var(--radius-sm);
  background: var(--surface-soft); color: var(--content-secondary);
}
.tool-details-loading { color: var(--content-tertiary); font-size: var(--font-size-xs); }
.tool-event-section + .tool-event-section { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--panel-divider); }
.tool-event-caption { display: block; margin-bottom: 4px; color: var(--content-tertiary); font-size: var(--font-size-xs); font-weight: 600; }
.tool-event-limit { margin-left: 6px; color: var(--content-tertiary); font-weight: 400; }
pre { max-height: 180px; margin: 0; overflow: auto; color: var(--content-primary); white-space: pre-wrap; word-break: break-word; font: var(--font-size-xs)/var(--line-height-body) var(--font-family-mono); }
.tool-detail-shell { min-height: 0; overflow: hidden; }
.tool-detail-shell > .tool-event-detail { min-height: 0; overflow: hidden; }
</style>
