<template>
  <div ref="root" class="list-select" @keydown.esc="close">
    <button
      class="list-select-trigger"
      type="button"
      role="combobox"
      aria-haspopup="listbox"
      :aria-label="label"
      :aria-expanded="open"
      :aria-controls="listboxId"
      @click="open = !open"
    >
      <span>{{ selectedLabel }}</span>
      <FlipChevron :open="open" :size="10" />
    </button>
    <div v-if="open" :id="listboxId" class="list-select-overlay" role="listbox" :aria-label="label">
      <button
        v-for="option in options"
        :key="option.value"
        class="list-select-option"
        :class="{ selected: option.value === modelValue }"
        type="button"
        role="option"
        :aria-selected="option.value === modelValue"
        @click="select(option.value)"
      >
        <span>{{ option.label }}</span>
        <span v-if="option.value === modelValue" class="list-select-check" aria-hidden="true">✓</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import FlipChevron from './FlipChevron.vue'

const props = defineProps<{
  modelValue: string
  label: string
  options: Array<{ value: string; label: string }>
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const root = ref<HTMLElement | null>(null)
const open = ref(false)
const listboxId = `list-select-${Math.random().toString(36).slice(2)}`
const selectedLabel = computed(() => props.options.find(option => option.value === props.modelValue)?.label ?? '')

function close() { open.value = false }
function select(value: string) {
  emit('update:modelValue', value)
  close()
}
function onDocumentPointerDown(event: PointerEvent) {
  if (!root.value?.contains(event.target as Node)) close()
}
onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown))
onUnmounted(() => document.removeEventListener('pointerdown', onDocumentPointerDown))
</script>

<style scoped>
.list-select{position:relative;min-width:118px}
.list-select-trigger{width:100%;min-height:34px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 10px;border:1px solid var(--border-default);border-radius:var(--radius-sm);background:var(--surface-raised);color:var(--content-primary);font:inherit;text-align:left;cursor:pointer}
.list-select-trigger:hover{background:var(--surface-list-option-hover)}
.list-select-overlay{position:absolute;top:calc(100% + 6px);left:0;z-index:30;width:max(100%,164px);max-height:260px;overflow:auto;padding:5px;border:1px solid var(--border-list-overlay);border-radius:var(--radius-list-overlay);background:var(--surface-list-overlay);box-shadow:var(--elevation-list-overlay);backdrop-filter:blur(20px)}
.list-select-option{width:100%;min-height:32px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 9px;border:0;border-radius:var(--radius-xs);background:transparent;color:var(--content-secondary);font:inherit;text-align:left;cursor:pointer}
.list-select-option:hover,.list-select-option.selected{background:var(--surface-list-option-hover);color:var(--content-primary)}
.list-select-check{color:var(--action-primary)}
.list-select-trigger:focus-visible,.list-select-option:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}
</style>
