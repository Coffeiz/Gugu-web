<template>
  <div class="asel-wrap" ref="wrapRef">
    <div class="asel-trigger" :class="{ open: show }" :style="{ minWidth: triggerMinW + 'px' }" @click="toggle">
      <span :class="{ placeholder: !modelValue }">{{ selectedLabel }}</span>
      <FlipChevron :open="show" :size="11" class="asel-chevron" />
    </div>

    <PopupMenu :show="show" :anchor="wrapRef" popup-class="asel-popup popup-menu-dark asel-popup--model-list">
          <button
            v-for="opt in options" :key="opt.value"
            class="popup-menu-item"
            :class="{ active: modelValue === opt.value }"
            @mousedown.prevent="select(opt.value)"
          >{{ opt.label }}</button>
    </PopupMenu>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, type PropType } from 'vue'
import FlipChevron from '@/components/common/FlipChevron.vue'
import PopupMenu from '@/components/common/PopupMenu.vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  options:    { type: Array as PropType<{ value: any; label: string }[]>, default: () => [] },
  placeholder:{ type: String, default: '请选择' },
})
const emit = defineEmits(['update:modelValue'])

const show      = ref(false)
const wrapRef   = ref<HTMLElement | null>(null)

const selectedLabel = computed(() =>
  props.options.find(o => o.value === props.modelValue)?.label ?? props.placeholder
)

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

function toggle() {
  show.value = !show.value
}

function select(value: any) {
  emit('update:modelValue', value)
  show.value = false
}

function onClickOutside(e: MouseEvent) {
  const t = e.target as HTMLElement | null
  if (!wrapRef.value?.contains(t) && !t?.closest('.asel-popup'))
    show.value = false
}
onMounted(() => document.addEventListener('mousedown', onClickOutside))
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onClickOutside)
})
</script>

<style scoped>
.asel-wrap { position: relative; display: inline-block; }

.asel-trigger {
  display: flex; align-items: center; gap: 8px;
  height: 34px; padding: 0 12px; border-radius: 9px;
  border: 1px solid var(--input-border);
  background: var(--input-bg);
  color: var(--input-fg); font-size: 13px;
  cursor: pointer; transition: border-color 0.15s, background 0.15s;
  user-select: none; min-width: 110px;
  font-family: var(--font-sans);
}
.asel-trigger:hover,
.asel-trigger.open { border-color: var(--input-border-hover); background: var(--input-bg-hover); }
.asel-trigger span { flex: 1; }
.placeholder { color: var(--input-placeholder); }

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
