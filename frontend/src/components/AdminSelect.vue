<template>
  <div class="asel-wrap" ref="wrapRef">
    <div class="asel-trigger" :class="{ open: show }" @click="toggle">
      <span :class="{ placeholder: !modelValue }">{{ selectedLabel }}</span>
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" class="asel-chevron" :class="{ up: show }">
        <path d="M3 6l5 5 5-5"/>
      </svg>
    </div>

    <Teleport to="body">
      <div v-if="show" class="asel-popup popup-menu-dark" :style="popupStyle">
        <button
          v-for="opt in options" :key="opt.value"
          class="popup-menu-item"
          :class="{ active: modelValue === opt.value }"
          @click="select(opt.value)"
        >{{ opt.label }}</button>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  options:    { type: Array, default: () => [] },
  placeholder:{ type: String, default: '请选择' },
})
const emit = defineEmits(['update:modelValue'])

const show      = ref(false)
const wrapRef   = ref(null)
const popupStyle = ref({})

const selectedLabel = computed(() =>
  props.options.find(o => o.value === props.modelValue)?.label ?? props.placeholder
)

function toggle() {
  show.value = !show.value
  if (show.value) setTimeout(position, 0)
}

function position() {
  const rect = wrapRef.value?.getBoundingClientRect()
  if (!rect) return
  const below = rect.bottom + props.options.length * 36 + 16 < window.innerHeight
  popupStyle.value = {
    position: 'fixed',
    left: `${rect.left}px`,
    minWidth: `${rect.width}px`,
    top: below ? `${rect.bottom + 5}px` : `${rect.top - props.options.length * 36 - 16}px`,
    zIndex: 9999,
  }
}

function select(value) {
  emit('update:modelValue', value)
  show.value = false
}

function onClickOutside(e) {
  if (!wrapRef.value?.contains(e.target) && !e.target.closest('.asel-popup'))
    show.value = false
}
onMounted(() => document.addEventListener('mousedown', onClickOutside))
onBeforeUnmount(() => document.removeEventListener('mousedown', onClickOutside))
</script>

<style scoped>
.asel-wrap { position: relative; display: inline-block; }

.asel-trigger {
  display: flex; align-items: center; gap: 8px;
  height: 34px; padding: 0 12px; border-radius: 9px;
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.05);
  color: rgba(255,255,255,0.75); font-size: 13px;
  cursor: pointer; transition: border-color 0.15s, background 0.15s;
  user-select: none; min-width: 110px;
  font-family: var(--font-sans);
}
.asel-trigger:hover,
.asel-trigger.open { border-color: rgba(255,255,255,0.22); background: rgba(255,255,255,0.08); }
.asel-trigger span { flex: 1; }
.placeholder { color: rgba(255,255,255,0.28); }

.asel-chevron { color: rgba(255,255,255,0.35); flex-shrink: 0; transition: transform 0.15s; }
.asel-chevron.up { transform: rotate(180deg); }

.asel-popup { min-width: 120px; }
</style>
