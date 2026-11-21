<template>
  <component :is="button ? 'button' : 'div'" class="activity-line"
    :class="{ 'activity-summary': button }" :type="button ? 'button' : undefined">
    <span class="activity-symbol" :class="{ 'is-running': indicator === 'running' }" aria-hidden="true">
      <span v-if="indicator === 'dots'" class="activity-dots"><i v-for="dot in 3" :key="dot" /></span>
      <template v-else-if="indicator === 'arrow'">↳</template>
    </span>
    <span class="activity-text" role="status">
      <Transition :css="false" :appear="indicator !== 'arrow'" @enter="fadeLabel">
        <span :key="label" class="activity-label">{{ label }}</span>
      </Transition>
      <slot name="status" />
    </span>
    <slot />
  </component>
</template>

<script setup lang="ts">
import { animateStreamFade } from '@/components/common/content/markdownStreamMotion'

defineProps<{
  button?: boolean
  label: string
  indicator: 'dots' | 'running' | 'arrow'
}>()

function fadeLabel(element: Element) {
  if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) animateStreamFade(element)
}
</script>

<style scoped>
.activity-line {
  display: flex; align-items: center; gap: 7px;
  box-sizing: border-box; width: 100%; min-height: 26px;
  padding: 4px 10px; border: 0;
  background: transparent; color: var(--content-secondary); font: inherit; font-size: var(--font-size-sm);
  text-align: start;
}
.activity-summary {
  cursor: pointer; border-radius: var(--radius-sm);
  transition: background-color var(--motion-hover-control) var(--motion-ease-standard);
}
.activity-summary:hover { background-color: var(--surface-soft-hover); }
.activity-summary:focus-visible { outline: 2px solid var(--border-focus); }
.activity-symbol { display: grid; place-items: center; flex: none; width: 12px; }
.activity-symbol.is-running { color: var(--action-primary); }
.activity-symbol.is-running::before {
  content: ''; width: 7px; height: 7px; border-radius: 50%; background: currentColor;
  animation: activity-pulse 1100ms var(--motion-ease-standard) infinite;
}
.activity-text { min-width: 0; overflow-wrap: anywhere; }
.activity-summary .activity-text { flex: 1; display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 7px; }
.activity-summary .activity-label { min-width: 0; font-weight: 500; color: var(--content-primary); }
.activity-label { display: inline-block; }
.activity-dots { display: inline-flex; align-items: center; gap: 1.5px; }
.activity-dots i {
  width: 3px; height: 3px; border-radius: 50%; background: currentColor;
  animation: activity-pulse 1000ms var(--motion-ease-standard) infinite;
}
.activity-dots i:nth-child(2) { animation-delay: 120ms; }
.activity-dots i:nth-child(3) { animation-delay: 240ms; }
.activity-summary :slotted(.flip-chevron) { flex: none; }
@keyframes activity-pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .activity-symbol.is-running::before, .activity-dots i { animation: none; }
  .activity-summary { transition: none; }
}
</style>
