<template>
  <div class="theme-controls" aria-label="主题切换">
    <div class="control-cluster">
      <span class="control-label">主题</span>
      <div class="segmented">
        <button v-for="item in families" :key="item.value" :class="{ active: family === item.value }" @click="$emit('update:family', item.value)">{{ item.label }}</button>
      </div>
    </div>
    <div class="control-cluster">
      <span class="control-label">模式</span>
      <div class="segmented">
        <button v-for="item in themes" :key="item.value" :class="{ active: modelValue === item.value }" @click="$emit('update:modelValue', item.value)">{{ item.label }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ThemeFamily, ThemePreference } from '@/composables/useTheme'

defineProps<{ modelValue: ThemePreference; family: ThemeFamily }>()
defineEmits<{ 'update:modelValue': [value: ThemePreference]; 'update:family': [value: ThemeFamily] }>()
const families: Array<{ value: ThemeFamily; label: string }> = [
  { value: 'glass', label: 'Glass' }, { value: 'v2', label: 'V2' },
]
const themes: Array<{ value: ThemePreference; label: string }> = [
  { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' },
]
</script>

<style scoped>
.theme-controls { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 10px; margin-left: auto; }
.control-cluster { display: flex; align-items: center; gap: 6px; }
.control-label { color: var(--content-tertiary); font-size: 9px; letter-spacing: var(--tracking-label); }
.segmented { display: flex; gap: 2px; padding: 3px; border: 1px solid var(--border-subtle); border-radius: 11px; background: var(--surface-soft); box-shadow: var(--shadow-1); backdrop-filter: blur(14px); }
.segmented button { min-width: 66px; height: 28px; border: 0; border-radius: 8px; padding: 0 10px; color: var(--content-secondary); background: transparent; cursor: pointer; font: 620 10px var(--font-sans); transition: .16s var(--ease-standard); }
.segmented button:hover { color: var(--content-primary); background: var(--surface-soft-hover); }
.segmented button.active { color: var(--selection-fg); background: var(--surface-raised); box-shadow: var(--shadow-1); }
@media (max-width: 640px) { .theme-controls { width: 100%; margin-left: 0; } }
</style>
