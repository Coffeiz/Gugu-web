<template>
  <div class="asel-wrap" ref="wrapRef">
    <div class="asel-trigger" :class="{ open: show }" :style="{ minWidth: triggerMinW + 'px' }" @click="toggle">
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
  if (show.value) setTimeout(position, 0)
}

function position() {
  const rect = wrapRef.value?.getBoundingClientRect()
  if (!rect) return
  const below = rect.bottom + props.options.length * 36 + 16 < window.innerHeight
  // Trigger already auto-sized to fit longest option; popup matches trigger width
  const overflow = rect.right > window.innerWidth - 8
  const style = {
    position: 'fixed',
    minWidth: `${rect.width}px`,
    top: below ? `${rect.bottom + 5}px` : `${rect.top - props.options.length * 36 - 16}px`,
    zIndex: 9999,
  }
  if (overflow) {
    style.right = `${window.innerWidth - rect.right}px`
  } else {
    style.left = `${rect.left}px`
  }
  popupStyle.value = style
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
