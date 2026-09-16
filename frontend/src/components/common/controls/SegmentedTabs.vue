<template>
  <SegmentedControl
    class="segment-tabs"
    :class="{ compact: size === 'compact' }"
    :active-index="activeIndex"
    role="tablist"
    :aria-label="ariaLabel"
  >
    <button
      v-for="tab in tabs"
      :key="tab.key"
      type="button"
      class="segment-tab"
      :class="{ active: modelValue === tab.key }"
      role="tab"
      :aria-selected="modelValue === tab.key"
      @click="emit('update:modelValue', tab.key)"
    >{{ tab.label }}</button>
  </SegmentedControl>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import SegmentedControl from './SegmentedControl.vue'

interface TabItem { key: string; label: string }

const props = withDefaults(defineProps<{
  tabs: TabItem[]
  modelValue: string
  ariaLabel?: string
  size?: 'default' | 'compact'
}>(), { ariaLabel: '页面分类', size: 'default' })

const emit = defineEmits<{ (event: 'update:modelValue', value: string): void }>()
const activeIndex = computed(() => Math.max(0, props.tabs.findIndex(tab => tab.key === props.modelValue)))
</script>

<style scoped>
.segment-tabs {
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--segmented-track-bg);
  width: fit-content;
  max-width: 100%;
  overflow-x: auto;
  scrollbar-width: none;
  --pill-bg: var(--segmented-pill-bg);
  --pill-shadow: var(--segmented-pill-shadow);
}
.segment-tabs::-webkit-scrollbar { display: none; }
.segment-tab {
  flex: 0 0 auto;
  padding: 7px 14px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--control-fg);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color var(--motion-hover-control) var(--motion-ease-standard), color var(--motion-hover-control) var(--motion-ease-standard);
}
.segment-tab:hover:not(.active) { color: var(--content-primary); background: var(--surface-soft-hover); }
.segment-tab.active { color: var(--content-primary); }
.segment-tabs.compact {
  height: 32px;
  box-sizing: border-box;
  padding: 2px;
  border-radius: var(--radius-sm);
}
.segment-tabs.compact .segment-tab {
  height: 26px;
  padding: 0 12px;
  border-radius: var(--radius-xs);
}
</style>
