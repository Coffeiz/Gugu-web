<template>
  <div class="tool-event-bubble">
    <button class="tool-event-head" type="button" :aria-expanded="expanded" @click="expanded = !expanded">
      <span class="tool-event-state" :class="`is-${msg.toolStatus || 'running'}`" aria-hidden="true" />
      <span class="tool-event-label">{{ msg.toolLabel || msg.toolName || '工具调用' }}</span>
      <span class="tool-event-meta">{{ statusText }}</span>
      <span v-if="durationText" class="tool-event-duration">{{ durationText }}</span>
      <FlipChevron :open="expanded" :size="10" :transition="'transform var(--motion-hover-card) var(--motion-ease-emphasis)'" aria-hidden="true" />
    </button>
    <Transition
      :css="false"
      @before-enter="prepareDetailEnter"
      @enter="animateDetailEnter"
      @after-enter="cleanupDetailTransition"
      @before-leave="prepareDetailLeave"
      @leave="animateDetailLeave"
      @after-leave="cleanupDetailTransition"
    >
      <div v-if="expanded" class="tool-detail-shell">
        <div class="tool-event-detail">
          <div v-if="msg.toolInput !== undefined" class="tool-event-section">
            <span class="tool-event-caption">输入</span>
            <pre>{{ formatValue(msg.toolInput) }}</pre>
          </div>
          <div v-if="msg.toolResult !== undefined" class="tool-event-section">
            <span class="tool-event-caption">结果</span>
            <pre>{{ formatValue(msg.toolResult) }}</pre>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import FlipChevron from '@/components/common/FlipChevron.vue'
import type { ChatMessage } from './chatTypes'

const props = defineProps<{ msg: ChatMessage }>()
const expanded = ref(false)
const statusText = computed(() => ({
  running: '进行中', waiting: '等待回复', success: '已完成', error: '失败', skipped: '已跳过',
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

const detailTransition = 'height var(--motion-hover-card) var(--motion-ease-emphasis), opacity var(--motion-hover-card) var(--motion-ease-standard)'

function prepareDetailEnter(element: Element) {
  const node = element as HTMLElement
  node.style.height = '0px'
  node.style.opacity = '0'
  node.style.overflow = 'hidden'
}

function prepareDetailLeave(element: Element) {
  const node = element as HTMLElement
  node.style.height = `${node.getBoundingClientRect().height}px`
  node.style.opacity = '1'
  node.style.overflow = 'hidden'
}

function animateDetail(element: Element, targetHeight: string, targetOpacity: string, done: () => void) {
  const node = element as HTMLElement
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    node.removeEventListener('transitionend', onEnd)
    done()
  }
  const onEnd = (event: TransitionEvent) => {
    if (event.propertyName === 'height') finish()
  }
  node.addEventListener('transitionend', onEnd)
  node.style.transition = detailTransition
  requestAnimationFrame(() => {
    node.style.height = targetHeight
    node.style.opacity = targetOpacity
  })
  window.setTimeout(finish, 380)
}

function animateDetailEnter(element: Element, done: () => void) {
  const node = element as HTMLElement
  animateDetail(node, `${node.scrollHeight}px`, '1', done)
}

function animateDetailLeave(element: Element, done: () => void) {
  animateDetail(element, '0px', '0', done)
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
.tool-event-bubble { width: min(360px, 88%); margin: 0; border: 1px solid var(--border-default); border-radius: var(--card-radius); background: var(--surface-glass); color: var(--content-secondary); box-shadow: inset 0 1px 0 var(--highlight-soft), var(--elevation-card); overflow: hidden; transition: background var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), box-shadow var(--motion-hover-control) var(--motion-ease-standard); }
.tool-event-bubble:has(.tool-event-head:hover) { background: var(--surface-glass-hover); border-color: var(--border-hover); box-shadow: var(--elevation-card-hover); }
.tool-event-head { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto auto; grid-template-rows: auto auto; align-items: center; column-gap: 9px; width: 100%; min-height: 54px; border: 0; padding: 10px 12px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.tool-event-head:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--border-focus); }
.tool-event-state { grid-row: 1 / span 2; width: 8px; height: 8px; border-radius: var(--radius-pill); background: var(--content-tertiary); }
.tool-event-state.is-running { background: var(--action-primary); animation: tool-pulse 1.2s ease-in-out infinite; }
.tool-event-state.is-success { background: var(--status-success); }
.tool-event-state.is-error { background: var(--status-danger); }
.tool-event-state.is-skipped { background: var(--status-warning); }
.tool-event-label { min-width: 0; color: var(--content-primary); font-size: var(--font-size-sm); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-event-meta { grid-column: 2; grid-row: 2; color: var(--content-secondary); font-size: var(--font-size-xs); white-space: nowrap; }
.tool-event-duration { grid-column: 3; grid-row: 1 / span 2; align-self: center; color: var(--content-tertiary); font-size: var(--font-size-xs); white-space: nowrap; }
.tool-event-head :deep(.flip-chevron) { grid-column: 4; grid-row: 1 / span 2; align-self: center; }
.tool-event-detail { padding: 10px 12px 11px; border-top: 1px solid var(--border-default); background: var(--surface-raised); color: var(--content-secondary); }
.tool-event-section + .tool-event-section { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border-default); }
.tool-event-caption { display: block; margin-bottom: 4px; color: var(--content-tertiary); font-size: var(--font-size-xs); font-weight: 600; }
pre { max-height: 180px; margin: 0; overflow: auto; color: var(--content-primary); white-space: pre-wrap; word-break: break-word; font: var(--font-size-xs)/var(--line-height-body) var(--font-family-mono); }
.tool-detail-shell { min-height: 0; overflow: hidden; }
.tool-detail-shell > .tool-event-detail { min-height: 0; overflow: hidden; }
@keyframes tool-pulse { 50% { opacity: .35; } }
</style>
