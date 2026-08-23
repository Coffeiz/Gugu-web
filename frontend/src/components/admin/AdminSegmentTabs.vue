<template>
  <div class="segment-tabs" role="tablist" :aria-label="ariaLabel">
    <button
      v-for="tab in tabs"
      :key="tab.key"
      type="button"
      class="segment-tab"
      :class="{ active: modelValue === tab.key }"
      role="tab"
      :aria-selected="modelValue === tab.key"
      @click="$emit('update:modelValue', tab.key)"
    >{{ tab.label }}</button>
  </div>
</template>

<script setup lang="ts">
interface TabItem { key: string; label: string }

withDefaults(defineProps<{
  tabs: TabItem[]
  modelValue: string
  ariaLabel?: string
}>(), { ariaLabel: '页面分类' })

defineEmits<{ (event: 'update:modelValue', value: string): void }>()
</script>

<style scoped>
.segment-tabs {
  display: flex;
  gap: 4px;
  padding: 4px;
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 10px;
  background: rgba(255,255,255,0.035);
  width: fit-content;
  max-width: 100%;
  overflow-x: auto;
  scrollbar-width: none;
}
.segment-tabs::-webkit-scrollbar { display: none; }
.segment-tab {
  flex: 0 0 auto;
  padding: 7px 14px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: rgba(255,255,255,0.42);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: background .18s, color .18s, box-shadow .18s;
}
.segment-tab:hover:not(.active) { color: rgba(255,255,255,0.76); background: rgba(255,255,255,0.05); }
.segment-tab.active {
  color: rgba(255,255,255,0.92);
  background: rgba(123,127,178,0.28);
  box-shadow: inset 0 1px rgba(255,255,255,0.08);
}
</style>
