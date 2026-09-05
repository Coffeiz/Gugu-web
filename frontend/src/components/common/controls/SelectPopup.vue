<template>
  <div ref="rootRef" class="select-popup" :class="{ 'select-popup--disabled': disabled }">
    <button
      type="button"
      class="select-popup-trigger"
      :class="[triggerClass, { open: open, disabled: disabled }]"
      :disabled="disabled"
      :aria-expanded="open"
      @click="toggle"
    >
      <span>{{ selectedLabel }}</span>
      <FlipChevron :open="open" :size="11" class="select-popup-chevron" />
    </button>

    <PopupMenu :show="open" :anchor="rootRef" :popup-class="popupClass ? `select-popup-host ${popupClass}` : 'select-popup-host'">
      <slot name="options" :select="select" :close="close" :open="open">
        <button
          v-for="option in options"
          :key="option.value"
          type="button"
          class="popup-menu-item"
          :class="{ active: modelValue === option.value }"
          @mousedown.prevent="select(option.value)"
        >{{ option.label }}</button>
      </slot>
    </PopupMenu>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, type PropType } from 'vue'
import FlipChevron from '@/components/common/controls/FlipChevron.vue'
import PopupMenu from '@/components/common/overlays/PopupMenu.vue'

interface SelectOption { value: string; label: string }

const props = defineProps({
  modelValue: { type: String, default: '' },
  options: { type: Array as PropType<SelectOption[]>, default: () => [] },
  selectedLabel: { type: String, default: '' },
  placeholder: { type: String, default: '请选择' },
  disabled: { type: Boolean, default: false },
  triggerClass: { type: String, default: '' },
  popupClass: { type: String, default: '' },
})
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const rootRef = ref<HTMLElement | null>(null)
const open = ref(false)

const selectedText = computed(() =>
  props.options.find(option => option.value === props.modelValue)?.label ?? props.placeholder,
)
const selectedLabel = computed(() => props.selectedLabel || selectedText.value)

function toggle() {
  if (props.disabled) return
  open.value = !open.value
}

function close() {
  open.value = false
}

function select(value: string) {
  emit('update:modelValue', value)
  close()
}

function onClickOutside(event: MouseEvent) {
  const target = event.target as Node | null
  if (!rootRef.value?.contains(target)) close()
}

onMounted(() => document.addEventListener('mousedown', onClickOutside))
onBeforeUnmount(() => document.removeEventListener('mousedown', onClickOutside))

defineExpose({ close, open, root: rootRef })
</script>

<style scoped>
.select-popup { position: relative; display: inline-block; }
.select-popup-trigger {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  width: 100%; min-width: 110px; height: 34px; padding: 0 12px;
  border: 1px solid var(--input-border); border-radius: 9px;
  background: var(--input-bg); color: var(--input-fg);
  font: 13px var(--font-sans); text-align: left; cursor: pointer;
  transition: background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), color var(--motion-hover-control) var(--motion-ease-standard);
}
.select-popup-trigger:hover:not(:disabled), .select-popup-trigger.open { border-color: var(--input-border-hover); background: var(--input-bg-hover); }
.select-popup-trigger:disabled, .select-popup-trigger.disabled { cursor: default; opacity: .55; }
.select-popup-trigger > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.select-popup-chevron { flex-shrink: 0; color: var(--popup-item-fg-muted); }
:global(.select-popup-host) { min-width: 120px; }
</style>
