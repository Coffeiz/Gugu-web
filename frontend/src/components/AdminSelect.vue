<template>
  <SelectPopup
    :model-value="modelValue"
    :options="options"
    :placeholder="placeholder"
    :disabled="disabled"
    :style="{ minWidth: triggerMinW + 'px' }"
    trigger-class="asel-trigger"
    popup-class="asel-popup popup-menu-dark asel-popup--model-list"
    @update:model-value="emit('update:modelValue', $event)"
  />
</template>

<script setup lang="ts">
import { computed, type PropType } from 'vue'
import SelectPopup from '@/components/common/controls/SelectPopup.vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  options:    { type: Array as PropType<{ value: any; label: string }[]>, default: () => [] },
  placeholder:{ type: String, default: '请选择' },
  disabled:   { type: Boolean, default: false },
})
const emit = defineEmits<{ 'update:modelValue': [value: any] }>()

// Auto min-width to fit the longest option label
// Chinese chars ≈ 15px, ASCII chars ≈ 8px; plus trigger padding (12px * 2) + chevron (11+8=19px)
const triggerMinW = computed(() => {
  if (!props.options.length) return 110
  const max = Math.max(...props.options.map(o => {
    let w = 0
    for (const ch of o.label) w += ch.charCodeAt(0) > 0x7f ? 15 : 8
    return w + 24 + 19  // padding + chevron
  }))
  return Math.max(110, max)
})
</script>

<style scoped>
.asel-trigger {
  min-width: 110px;
}

.asel-chevron { color: var(--popup-item-fg-muted); }

.asel-popup { min-width: 120px; }
.asel-popup--model-list {
  display: flex;
  flex-direction: column;
  row-gap: 1px;
  padding: var(--popup-surface-padding);
  border: 1px solid var(--popup-surface-border);
  border-radius: var(--popup-surface-radius);
  background: var(--popup-surface-bg);
  box-shadow: var(--popup-surface-shadow), inset 0 1px 0 var(--popup-surface-highlight);
  backdrop-filter: var(--popup-surface-blur);
  -webkit-backdrop-filter: var(--popup-surface-blur);
}
.asel-popup--model-list .popup-menu-item {
  display: block;
  width: 100%;
  margin-top: 0;
  padding: var(--popup-item-padding);
  border-radius: var(--popup-item-radius);
  text-align: left;
}
</style>
