<template>
  <span class="color-swatches" @pointerdown.stop @click.stop>
    <button
      v-for="option in options" :key="option.key"
      class="cs-dot" :class="{ 'cs-none': !option.color, active: (modelValue || null) === option.color }"
      :style="{ background: option.background }"
      :title="t(option.label)"
      :aria-label="t(option.label)"
      :aria-pressed="(modelValue || null) === option.color"
      type="button"
      @click="emit('update:modelValue', option.color)"
    ></button>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { NOTE_COLOR_OPTIONS } from '@/utils/projectColors'

const { t } = useI18n()
const palette = NOTE_COLOR_OPTIONS.map(option => ({
  ...option, label: `mindUi.colors.${option.key}`,
}))
const noColor = { key: 'none', color: null, label: 'mindUi.defaultColor', background: undefined }

const props = defineProps<{
  modelValue: string | null
  allowNone?: boolean
}>()
const emit = defineEmits<{ (e: 'update:modelValue', color: string | null): void }>()

const options = computed(() => props.allowNone === false ? palette : [noColor, ...palette])
</script>

<style scoped>
.color-swatches { display: inline-flex; align-items: center; gap: 4px; margin-right: 3px; }
.cs-dot {
  width: 12px; height: 12px; flex-shrink: 0; border-radius: 50%; padding: 0; cursor: pointer;
  border: 1px solid rgba(255,255,255,0.85); box-shadow: 0 1px 2px rgba(80,90,110,0.18);
  transition: transform 0.12s ease;
}
.cs-dot:hover { transform: scale(1.15); }
.cs-dot.active { box-shadow: 0 0 0 2px var(--color-primary), 0 1px 2px rgba(80,90,110,0.18); }
/* 棋盘格代表"不上色"，跟色板软件的透明色图标同一个约定，不会被误认成"白色" */
.cs-none { background: repeating-conic-gradient(#dcdce2 0% 25%, #fff 0% 50%) 0 0 / 6px 6px; }
</style>
