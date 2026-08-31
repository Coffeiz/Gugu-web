<template>
  <div class="theme-controls" aria-label="主题切换">
    <div class="control-cluster">
      <span class="control-label">配色</span>
      <div class="segmented">
        <button v-for="item in palettes" :key="item.value" :class="{ active: palette === item.value }" @click="$emit('update:palette', item.value)">{{ item.label }}</button>
      </div>
    </div>
    <div class="control-cluster">
      <span class="control-label">主题</span>
      <div class="segmented">
        <button v-for="item in families" :key="item.value" class="family-choice" :class="{ active: family === item.value }" @click="$emit('update:family', item.value)">{{ item.label }}</button>
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
import type { ThemeFamily, ThemePalette, ThemePreference } from '@/composables/useTheme'

defineProps<{ modelValue: ThemePreference; family: ThemeFamily; palette: ThemePalette }>()
defineEmits<{ 'update:modelValue': [value: ThemePreference]; 'update:family': [value: ThemeFamily]; 'update:palette': [value: ThemePalette] }>()
const families: Array<{ value: ThemeFamily; label: string }> = [
  { value: 'glass', label: 'Aero' }, { value: 'mono', label: 'Mono' },
]
const themes: Array<{ value: ThemePreference; label: string }> = [
  { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'System' },
]
const palettes: Array<{ value: ThemePalette; label: string }> = [
  { value: 'mist', label: 'Mist' }, { value: 'cafe', label: 'Cafe' },
  { value: 'rose', label: 'Rose' }, { value: 'sky', label: 'Sky' }, { value: 'sage', label: 'Sage' },
]
</script>

<style scoped>
.theme-controls { display:flex; align-items:center; justify-content:flex-end; flex-wrap:wrap; gap:var(--space-sm); margin-left:auto; }
.control-cluster { display:flex; align-items:center; gap:var(--space-xs); }
.control-label { color:var(--content-tertiary); font-size:var(--font-size-xs); font-weight:var(--font-weight-medium); letter-spacing:var(--tracking-label); }
.segmented { display:flex; gap:var(--space-xs); padding:var(--space-xs); border:1px solid var(--choice-chip-border); border-radius:var(--choice-chip-radius); background:var(--segmented-track-bg); }
.segmented button { min-width:58px; min-height:var(--choice-chip-min-height); height:var(--choice-chip-min-height); border:1px solid transparent; border-radius:var(--choice-chip-radius); padding:var(--choice-chip-padding); color:var(--choice-chip-fg); background:var(--choice-chip-bg); cursor:pointer; font:var(--font-weight-semibold) var(--font-size-xs) var(--font-sans); transition:background-color var(--motion-hover-control) var(--motion-ease-standard),border-color var(--motion-hover-control) var(--motion-ease-standard),color var(--motion-hover-control) var(--motion-ease-standard),box-shadow var(--motion-hover-control) var(--motion-ease-standard); }
.segmented button:hover { color:var(--choice-chip-fg-hover); background:var(--choice-chip-bg-hover); border-color:var(--choice-chip-border-hover); }
.segmented button.active { color:var(--selection-fg); background:var(--segmented-pill-bg); border-color:var(--choice-chip-border-active); box-shadow:var(--segmented-pill-shadow); }
.segmented button:focus-visible { outline:none; box-shadow:var(--control-focus-shadow); }
@media (max-width:720px) { .theme-controls { width:100%; margin-left:0; justify-content:flex-start; } }
</style>
