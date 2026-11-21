<template>
  <section class="tool-activity">
    <button type="button" class="activity-summary" :aria-expanded="expanded" @click="$emit('toggle')">
      <span class="activity-symbol" :class="{ 'is-running': running.length > 0 }" aria-hidden="true">
        {{ running.length ? '' : '↳' }}
      </span>
      <span class="activity-text" aria-live="polite">
        {{ label }}
        <span v-if="extra" class="activity-extra"> · {{ extra }}</span>
      </span>
      <FlipChevron :open="expanded" :size="10" :transition="chevronTransition" aria-hidden="true" />
    </button>
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
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import FlipChevron from '@/components/common/controls/FlipChevron.vue'
import GuguChatToolBubble from './GuguChatToolBubble.vue'
import type { ChatMessage } from './chatTypes'
import { toolActivityLabel } from './toolActivity'

const props = defineProps<{
  tools: ChatMessage[]
  sessionId: number | null
  expanded: boolean
  expandedTools: ReadonlySet<string>
  awaitingReply: boolean
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
const label = computed(() => {
  const active = running.value[0] ?? waiting.value ?? queued.value
  if (!active) return t('chatUi.toolActivityTotal', { count: props.tools.length })
  const tool = toolActivityLabel(active, t, te)
  if (running.value.length) return t('chatUi.toolActivityRunning', { tool })
  return `${tool} · ${t(waiting.value ? 'chatUi.toolWaiting' : 'chatUi.toolQueued')}`
})
const extra = computed(() => {
  if (running.value.length > 1) return t('chatUi.toolActivityParallel', { count: running.value.length - 1 })
  const statuses = []
  if (failed.value) statuses.push(t('chatUi.toolActivityFailed', { count: failed.value }))
  if (interrupted.value) statuses.push(t('chatUi.toolActivityInterrupted', { count: interrupted.value }))
  if (props.awaitingReply && !running.value.length && !waiting.value && !queued.value)
    statuses.push(t('chatUi.toolActivityPreparing'))
  return statuses.join(' · ')
})
</script>

<style scoped>
.tool-activity {
  inline-size: var(--chat-assistant-bubble-max-width, 88%);
  color: var(--content-secondary);
}
.activity-summary {
  display: flex; align-items: center; gap: 7px;
  width: 100%; min-height: 26px;
  padding: 4px 10px; border: 0;
  background: transparent; color: inherit; font: inherit; font-size: var(--font-size-sm);
  text-align: start; cursor: pointer;
}
.activity-summary, :deep(.tool-event-head) {
  border-radius: var(--radius-sm);
  transition: background-color var(--motion-hover-control) var(--motion-ease-standard);
}
.activity-summary:hover, :deep(.tool-event-head:hover) { background-color: var(--surface-soft-hover); }
.activity-summary:focus-visible { outline: 2px solid var(--border-focus); }
.activity-symbol { display: grid; place-items: center; flex: none; width: 12px; }
.activity-symbol.is-running {
  width: 11px; height: 11px; margin-inline-end: 1px; border: 1.5px solid var(--border-default);
  border-top-color: var(--action-primary); border-radius: 50%; animation: activity-spin 850ms linear infinite;
}
.activity-text { min-width: 0; overflow-wrap: anywhere; }
.activity-summary :deep(.flip-chevron) { margin-inline-start: auto; }
.activity-extra { color: var(--content-secondary); }
.activity-reveal { display: grid; grid-template-rows: 1fr; contain: inline-size; }
.activity-details { display: grid; gap: 5px; min-height: 0; overflow: hidden; }
.activity-details > :first-child { margin-top: 4px; }
.activity-expand-enter-active, .activity-expand-leave-active {
  transition: grid-template-rows var(--motion-hover-card) var(--motion-ease-emphasis),
    opacity var(--motion-hover-card) var(--motion-ease-standard);
}
.activity-expand-enter-from, .activity-expand-leave-to { grid-template-rows: 0fr; opacity: 0; }
@keyframes activity-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .activity-symbol.is-running { animation: none; }
  .activity-summary, :deep(.tool-event-head), :deep(.flip-chevron),
  .activity-expand-enter-active, .activity-expand-leave-active { transition: none; }
}
</style>
