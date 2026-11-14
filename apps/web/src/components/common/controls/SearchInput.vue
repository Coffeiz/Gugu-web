<template>
  <div class="search-input" :class="{ active, 'no-focus-ring': noFocusRing }">
    <Icon name="action.search" class="search-input-icon" :size="15" />
    <input
      ref="inputEl"
      :value="modelValue"
      class="search-input-field"
      type="search"
      :placeholder="placeholder || t('common.search')"
      :aria-label="ariaLabel || placeholder || t('common.search')"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @focus="emit('focus', $event)"
      @blur="emit('blur', $event)"
      @compositionstart="emit('compositionstart', $event)"
      @compositionend="emit('compositionend', $event)"
      @keydown="emit('keydown', $event)"
    />
    <button v-if="clearable && modelValue" class="search-input-clear" :title="t('common.actions.clear')" :aria-label="t('common.actions.clear')" @click="clear">
      <Icon name="action.close" :size="13" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import Icon from '@/components/common/icons/Icon.vue'
import { useI18n } from 'vue-i18n'
defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  ariaLabel: { type: String, default: '' },
  active: { type: Boolean, default: false },
  clearable: { type: Boolean, default: false },
  noFocusRing: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'focus', 'blur', 'compositionstart', 'compositionend', 'keydown', 'clear'])
const inputEl = ref<HTMLInputElement | null>(null)
const { t } = useI18n()

function clear() {
  emit('update:modelValue', '')
  emit('clear')
  inputEl.value?.focus()
}

defineExpose({ focus: () => inputEl.value?.focus() })
</script>

<style scoped>
.search-input {
  display:flex; align-items:center; gap:var(--space-2); width:100%; height:var(--control-height-md); min-height:var(--control-height-md);
  box-sizing:border-box; padding:0 12px; color:var(--input-fg); background:var(--input-bg); border:1px solid var(--input-border);
  border-radius:var(--control-radius); transition:background var(--motion-fast),border-color var(--motion-fast),box-shadow var(--motion-fast);
}
.search-input:focus-within, .search-input.active { background:var(--input-bg-focus); border-color:var(--input-border-focus); box-shadow:var(--input-focus-shadow); }
.search-input.no-focus-ring:focus-within, .search-input.no-focus-ring.active { box-shadow:none; }
.search-input-icon { flex:0 0 auto; }
.search-input:focus-within .search-input-icon, .search-input.active .search-input-icon { color:var(--action-primary); }
.search-input-field {
  flex:1; min-width:0; height:100%; padding:0; border:0; outline:0; appearance:none; -webkit-appearance:none;
  background:transparent; color:var(--content-primary); font:var(--font-weight-medium) var(--font-size-body)/var(--line-height-ui) var(--font-sans);
}
.search-input-field::-webkit-search-cancel-button { display:none; }
.search-input-field::placeholder { color:var(--content-tertiary); opacity:1; }
.search-input-clear { display:inline-flex; align-items:center; justify-content:center; flex:0 0 auto; width:20px; height:20px; padding:0; border:0; border-radius:var(--radius-xs); background:transparent; color:var(--content-secondary); cursor:pointer; }
.search-input-clear:hover { background:var(--action-soft); color:var(--action-primary); }
</style>
