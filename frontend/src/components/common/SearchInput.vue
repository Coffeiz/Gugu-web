<template>
  <div class="search-input" :class="{ active }">
    <PhMagnifyingGlass class="search-input-icon" :size="15" weight="bold" />
    <input
      ref="inputEl"
      :value="modelValue"
      class="search-input-field"
      type="search"
      :placeholder="placeholder"
      :aria-label="ariaLabel || placeholder"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @focus="emit('focus', $event)"
      @blur="emit('blur', $event)"
      @compositionstart="emit('compositionstart', $event)"
      @compositionend="emit('compositionend', $event)"
      @keydown="emit('keydown', $event)"
    />
    <button v-if="clearable && modelValue" class="search-input-clear" title="清除" @click="clear">
      <PhX :size="13" weight="bold" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { PhMagnifyingGlass, PhX } from '@phosphor-icons/vue'

defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '搜索' },
  ariaLabel: { type: String, default: '' },
  active: { type: Boolean, default: false },
  clearable: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'focus', 'blur', 'compositionstart', 'compositionend', 'keydown', 'clear'])
const inputEl = ref<HTMLInputElement | null>(null)

function clear() {
  emit('update:modelValue', '')
  emit('clear')
  inputEl.value?.focus()
}

defineExpose({ focus: () => inputEl.value?.focus() })
</script>

<style scoped>
.search-input { display: flex; align-items: center; gap: 8px; width: 100%; height: var(--control-height-md); min-height: var(--control-height-md); box-sizing: border-box; padding: 0 12px; background: var(--surface-glass); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); color: var(--content-secondary); transition: background .25s ease, border-color .25s ease, box-shadow .25s ease; }
.search-input:focus-within, .search-input.active { background: var(--surface-glass-hover); border-color: var(--border-focus); box-shadow: var(--shadow-rest); }
.search-input-icon { flex: 0 0 auto; }
.search-input:focus-within .search-input-icon, .search-input.active .search-input-icon { color: var(--color-primary); }
.search-input-field { flex: 1; min-width: 0; height: 100%; padding: 0; border: 0; outline: 0; appearance: none; -webkit-appearance: none; background: transparent; color: var(--content-primary); font: 500 var(--font-size-md)/18px var(--font-sans); }
.search-input-field::-webkit-search-cancel-button { display: none; }
.search-input-field::placeholder { color: var(--text-secondary); opacity: .75; }
.search-input-clear { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--text-secondary); cursor: pointer; }
.search-input-clear:hover { background: rgba(123,127,178,.12); color: var(--color-primary); }
</style>
