<template>
  <fieldset class="task-mode">
    <legend class="task-mode-label">{{ t('scheduleUi.taskMode') }}</legend>
    <div class="task-mode-options">
      <button v-for="mode in modes" :key="mode" type="button" class="task-mode-button"
        :aria-pressed="model === mode" @click="model = mode">
        {{ t(mode === 'reminder' ? 'scheduleUi.reminderMode' : 'scheduleUi.instructionMode') }}
      </button>
    </div>
  </fieldset>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { ScheduledTaskMode } from '@/services/api'

const { t } = useI18n()
const model = defineModel<ScheduledTaskMode>({ required: true })
const modes = ['reminder', 'instruction'] as const
</script>

<style scoped>
.task-mode { min-width: 0; margin: 0; border: 0; padding: 0; }
.task-mode-label { margin-bottom: 6px; font-size: 12px; font-weight: 700; color: var(--text-secondary); }
.task-mode-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.task-mode-button { box-sizing: border-box; min-height: var(--task-mode-height, 34px); padding: 0; border-radius: var(--task-mode-radius, var(--radius-xs)); border: 1px solid var(--task-mode-border, var(--option-border)); background: var(--task-mode-bg, var(--option-bg)); color: var(--task-mode-fg, var(--option-fg)); font: 13px var(--font-sans); cursor: pointer; transition: all 0.15s; }
.task-mode-button:hover { border-color: var(--task-mode-hover-border, var(--option-border-hover)); }
.task-mode-button[aria-pressed="true"] { background: var(--action-primary-bg); color: var(--content-on-accent); border-color: transparent; }
</style>
