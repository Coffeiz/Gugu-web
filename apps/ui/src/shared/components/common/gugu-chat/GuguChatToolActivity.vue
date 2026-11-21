<template>
  <section class="tool-activity">
    <GuguChatActivityLine button :aria-expanded="expanded" :label="displayedLabel"
      :indicator="phase === 'running' ? 'running' : displayedLabel === label && phase === 'processing' ? 'dots' : 'arrow'"
      @click="$emit('toggle')">
      <template #status>
        <template v-if="phase === 'complete'">
          <span v-if="failed" class="activity-meta is-failed">{{ t('chatUi.toolActivityFailed', { count: failed }) }}</span>
          <span v-if="interrupted" class="activity-meta">{{ t('chatUi.toolActivityInterrupted', { count: interrupted }) }}</span>
        </template>
      </template>
      <span v-if="phase === 'complete' && duration" class="activity-duration"
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
            :expanded="expandedTools.has(String(tool.id))"
            @update:expanded="value => $emit('detail', tool.id, value)"
          />
        </div>
      </div>
    </Transition>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import FlipChevron from '@/components/common/controls/FlipChevron.vue'
import GuguChatActivityLine from './GuguChatActivityLine.vue'
import GuguChatToolBubble from './GuguChatToolBubble.vue'
import type { ChatMessage } from './chatTypes'
import { formatToolDuration, toolActivityLabel, toolGroupElapsedMs } from './toolActivity'

const props = defineProps<{
  tools: ChatMessage[]
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
const failed = computed(() => props.tools.filter(tool => tool.toolStatus === 'error').length)
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
    const tool = toolActivityLabel(running.value[0]!, t, te)
    const current = t('chatUi.toolActivityRunning', { tool })
    return running.value.length > 1
      ? `${current} · ${t('chatUi.toolActivityParallel', { count: running.value.length - 1 })}`
      : current
  }
  if (phase.value === 'queued') return `${toolActivityLabel(queued.value!, t, te)} · ${t('chatUi.toolQueued')}`
  return t('chatUi.toolActivityTotal', { count: props.tools.length })
})
const duration = computed(() => formatToolDuration(props.elapsedMs ?? toolGroupElapsedMs(props.tools)))
const durationLabel = computed(() => t(props.elapsedMs === undefined
  ? 'chatUi.toolActivityGroupDuration' : 'chatUi.toolActivityDuration', { duration: duration.value }))
const displayedLabel = ref(phase.value === 'processing' ? '' : label.value)
watch([label, phase], ([nextLabel, nextPhase], previous, onCleanup) => {
  const show = () => { displayedLabel.value = nextLabel }
  if (nextPhase === 'processing' && previous.length > 0) {
    const timer = setTimeout(show, 300)
    onCleanup(() => clearTimeout(timer))
  } else {
    show()
  }
}, { immediate: true })
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
