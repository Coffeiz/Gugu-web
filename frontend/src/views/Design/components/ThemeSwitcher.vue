<template>
  <div class="theme-switcher" aria-label="主题切换">
    <button v-for="item in themes" :key="item.value" :class="{ active: modelValue === item.value }" @click="$emit('update:modelValue', item.value)">{{ item.label }}</button>
  </div>
</template>

<script setup lang="ts">
import type { ThemePreference } from '@/composables/useTheme'

defineProps<{ modelValue: ThemePreference }>()
defineEmits<{ 'update:modelValue': [value: ThemePreference] }>()
const themes: Array<{ value: ThemePreference; label: string }> = [
  { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }, { value: 'system', label: '跟随系统' },
]
</script>

<style scoped>
.theme-switcher { display: flex; gap: var(--space-1); padding: var(--space-1); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--surface-glass); }
.theme-switcher button { border: 0; border-radius: var(--radius-xs); padding: 7px 10px; color: var(--content-secondary); background: transparent; cursor: pointer; font: inherit; font-size: var(--font-size-sm); }
.theme-switcher button.active, .theme-switcher button:hover { color: var(--content-primary); background: var(--surface-glass-hover); }
</style>
