<template>
  <section class="tool-activity">
    <GuguChatActivityLine button :aria-expanded="expanded" :label="displayedLabel"
      :indicator="displayedPhase === 'running' ? 'running' : displayedPhase === 'processing' ? 'dots' : 'arrow'"
      :typing="typing" :motion-key="displayedKey"
      :typewritten="displayedPhase === 'running' || displayedPhase === 'queued'"
      @click="$emit('toggle')">
      <template #status>
        <template v-if="displayedPhase === 'complete'">
          <span v-if="failed" class="activity-meta is-failed">{{ t('chatUi.toolActivityFailed', { count: failed }) }}</span>
          <span v-if="interrupted" class="activity-meta">{{ t('chatUi.toolActivityInterrupted', { count: interrupted }) }}</span>
        </template>
      </template>
      <span v-if="displayedPhase === 'complete' && duration" class="activity-duration"
        :title="durationLabel" :aria-label="durationLabel">
        {{ duration }}
      </span>
      <FlipChevron :open="expanded" :size="10" :transition="chevronTransition" aria-hidden="true" />
    </GuguChatActivityLine>
    <Transition name="activity-expand">
      <div v-if="expanded" class="activity-reveal">
        <div class="activity-details">
          <GuguChatToolBubble
            v-for="tool in tools" :key="tool.id" :msg="tool" :session-id="sessionId"
            :subagent-names="subagentNames" :expanded="expandedTools.has(String(tool.id))"
            @update:expanded="value => $emit('detail', tool.id, value)"
          />
        </div>
      </div>
    </Transition>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue'
import { toolDisplayIdentity } from '@gugu/core/agent/sessions/tool-labels'
import { useI18n } from 'vue-i18n'
import FlipChevron from '@/components/common/controls/FlipChevron.vue'
import GuguChatActivityLine from './GuguChatActivityLine.vue'
import GuguChatToolBubble from './GuguChatToolBubble.vue'
import type { ChatMessage } from './chatTypes'
import { formatToolDuration, toolActivityLabel, toolGroupElapsedMs, toolHasNoMatches } from './toolActivity'

const props = defineProps<{
  tools: ChatMessage[]
  subagentNames?: ReadonlyMap<string, string>
  sessionId: number | null
  expanded: boolean
  expandedTools: ReadonlySet<string>
  awaitingReply: boolean
  elapsedMs?: number
}>()
defineEmits<{ toggle: []; detail: [id: number, expanded: boolean] }>()

const { t, te } = useI18n()
const chevronTransition = 'transform var(--motion-hover-card) var(--motion-ease-emphasis)'
const running = computed(() => props.tools.filter(tool => !tool.toolStatus || tool.toolStatus === 'running'))
const waiting = computed(() => props.tools.find(tool => tool.toolStatus === 'waiting'))
const queued = computed(() => props.tools.find(tool => tool.toolStatus === 'queued'))
const failed = computed(() => props.tools.filter(tool => tool.toolStatus === 'error' && !toolHasNoMatches(tool)).length)
const interrupted = computed(() => props.tools.filter(tool =>
  tool.toolStatus === 'cancelled' || tool.toolStatus === 'stopped' || tool.toolStatus === 'skipped' || tool.toolStatus === 'unknown',
).length)
const phase = computed(() => {
  if (waiting.value) return 'waiting'
  if (running.value.length) return 'running'
  if (queued.value) return 'queued'
  return props.awaitingReply ? 'processing' : 'complete'
})
const label = computed(() => {
  if (phase.value === 'processing') return t('chatUi.toolActivityPreparing')
  if (phase.value === 'waiting') return t('chatUi.toolWaiting')
  if (phase.value === 'running') {
    const tool = toolActivityLabel(running.value[0]!, t, te, props.subagentNames)
    const current = t('chatUi.toolActivityRunning', { tool })
    return running.value.length > 1
      ? `${current} · ${t('chatUi.toolActivityParallel', { count: running.value.length - 1 })}`
      : current
  }
  if (phase.value === 'queued') return `${toolActivityLabel(queued.value!, t, te, props.subagentNames)} · ${t('chatUi.toolQueued')}`
  const onlyTool = props.tools.length === 1 ? props.tools[0] : undefined
  if (onlyTool && toolDisplayIdentity(onlyTool.toolName, onlyTool.toolInput).name === 'shell') return toolActivityLabel(onlyTool, t, te, props.subagentNames)
  return t('chatUi.toolActivityTotal', { count: props.tools.length })
})
const duration = computed(() => formatToolDuration(props.elapsedMs ?? toolGroupElapsedMs(props.tools)))
const durationLabel = computed(() => t(props.elapsedMs === undefined
  ? 'chatUi.toolActivityGroupDuration' : 'chatUi.toolActivityDuration', { duration: duration.value }))
const primaryTool = computed(() => waiting.value ?? running.value[0] ?? queued.value)
const activityKey = computed(() => `${phase.value}:${primaryTool.value?.id ?? ''}`)
type Activity = { key: string; phase: typeof phase.value; label: string }

const charInterval = 32
const labelHold = 240
const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')
const displayedPhase = ref(phase.value)
const displayedLabel = ref('')
const displayedKey = ref('')
const typing = ref(false)
const queue: Activity[] = []
let current: Activity | undefined
let animation: ReturnType<typeof setTimeout> | undefined
let processingDelay: ReturnType<typeof setTimeout> | undefined

function show(activity: Activity) {
  current = activity
  displayedKey.value = activity.key
  displayedPhase.value = activity.phase
  displayedLabel.value = activity.label
}

function playNext() {
  const activity = queue.shift()
  if (!activity) return
  show(activity)
  if (activity.phase !== 'running' && activity.phase !== 'queued') {
    playNext()
    return
  }

  displayedLabel.value = ''
  typeLabel(activity)
}

function typeLabel(activity: Activity) {
  clearTimeout(animation)
  typing.value = true
  function typeNext() {
    const target = Array.from(activity.label)
    const displayed = Array.from(displayedLabel.value)
    let prefix = 0
    while (prefix < target.length && target[prefix] === displayed[prefix]) prefix++
    displayedLabel.value = target.slice(0, prefix + 1).join('')
    if (prefix + 1 < target.length) {
      animation = setTimeout(typeNext, charInterval)
      return
    }
    void nextTick(() => { typing.value = false })
    animation = setTimeout(() => {
      animation = undefined
      playNext()
    }, labelHold)
  }
  animation = setTimeout(typeNext, charInterval)
}

function enqueue(activity: Activity) {
  if (reducedMotion && reducedMotion.matches) {
    clearTimeout(animation)
    animation = undefined
    queue.length = 0
    typing.value = false
    show(activity)
    return
  }
  const tail = queue.at(-1) ?? current
  if (tail?.key === activity.key) {
    tail.label = activity.label
    if (tail === current && !typing.value && displayedLabel.value !== activity.label) {
      if (activity.phase === 'running' || activity.phase === 'queued') typeLabel(tail)
      else displayedLabel.value = activity.label
    }
    return
  }
  queue.push(activity)
  if (animation === undefined) playNext()
}

watch([activityKey, label, () => primaryTool.value?._replayedTool], ([key, nextLabel]) => {
  clearTimeout(processingDelay)
  const activity: Activity = { key, phase: phase.value, label: nextLabel }
  if (primaryTool.value?._replayedTool || activity.phase === 'complete') {
    clearTimeout(animation)
    animation = undefined
    queue.length = 0
    typing.value = false
    show(activity)
    return
  }
  // 短空档保持当前工具，避免「整理结果」闪现或进入播放队列。
  const last = queue.at(-1)
  if (last?.phase === 'processing' && activity.phase !== 'processing') queue.pop()
  if (activity.phase === 'processing' && current?.phase !== 'processing') {
    processingDelay = setTimeout(() => enqueue(activity), 300)
  } else {
    enqueue(activity)
  }
}, { immediate: true })

onScopeDispose(() => {
  clearTimeout(animation)
  clearTimeout(processingDelay)
})
</script>

<style scoped>
.tool-activity {
  inline-size: var(--chat-assistant-bubble-max-width, 88%);
  color: var(--content-secondary);
}
.activity-meta, .activity-duration { font-size: var(--font-size-xs); color: var(--content-secondary); }
.activity-meta.is-failed { color: var(--status-danger); }
.activity-duration { flex: none; color: var(--content-tertiary); white-space: nowrap; font-variant-numeric: tabular-nums; }
:deep(.tool-event-head) {
  border-radius: var(--radius-sm);
  transition: background-color var(--motion-hover-control) var(--motion-ease-standard);
}
:deep(.tool-event-head:hover) { background-color: var(--surface-soft-hover); }
.activity-reveal { display: grid; grid-template-rows: 1fr; contain: inline-size; }
.activity-details { display: grid; gap: 5px; min-height: 0; overflow: hidden; }
.activity-details > :first-child { margin-top: 4px; }
.activity-expand-enter-active, .activity-expand-leave-active {
  transition: grid-template-rows var(--motion-hover-card) var(--motion-ease-emphasis),
    opacity var(--motion-hover-card) var(--motion-ease-standard);
}
.activity-expand-enter-from, .activity-expand-leave-to { grid-template-rows: 0fr; opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  :deep(.tool-event-head), :deep(.flip-chevron),
  .activity-expand-enter-active, .activity-expand-leave-active { transition: none; }
}
</style>
