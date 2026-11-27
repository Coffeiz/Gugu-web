<template>
  <div class="event-form-body" :class="{ 'shared-event-popup': surface }">
    <div class="popup-header">
      <span class="popup-title">{{ title }}</span>
      <CloseButton compact @click="emit('close')" />
    </div>
    <EventFormFields :event="event" :form="form" :is-past-date="isPastDate" :autofocus="autofocus" :show-reminders="showReminders && form.remindersAvailable !== false"
                     @save="emit('save')" @close="emit('close')" @test-reminder="emit('test-reminder')" />
    <div class="popup-actions">
      <button class="popup-save" @click="emit('save')" :disabled="!event.name || saving">{{ t('common.actions.save') }}</button>
      <button v-if="showDelete" class="popup-delete" @click="emit('delete')">{{ t('common.actions.delete') }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
import CloseButton from '@/components/common/overlays/CloseButton.vue'
import EventFormFields from './EventFormFields.vue'
import { type EventDraft, type useEventEditForm } from '@/composables/calendar/useEventEditForm'

withDefaults(defineProps<{
  event: EventDraft
  form: ReturnType<typeof useEventEditForm>
  isPastDate: (date: string | null | undefined) => boolean
  title?: string
  showDelete?: boolean
  autofocus?: boolean
  saving?: boolean
  surface?: boolean
  showReminders?: boolean
}>(), { title: '编辑活动', showDelete: false, surface: false, showReminders: true })

const emit = defineEmits<{
  save: []
  close: []
  delete: []
  'test-reminder': []
}>()
</script>

<style scoped>
.event-form-body { display: flex; flex-direction: column; gap: 9px; padding: 16px; color: var(--content-primary); }
.event-form-body.shared-event-popup {
  box-sizing: border-box;
  max-height: calc(100dvh - 12px);
  overflow-y: auto;
  padding: var(--popup-content-inset);
  border: 1px solid var(--popup-surface-border);
  border-radius: var(--event-popup-radius);
  background: var(--popup-surface-bg);
  box-shadow: inset 0 1px 0 var(--popup-surface-highlight), var(--popup-surface-shadow);
  backdrop-filter: var(--popup-surface-blur);
  -webkit-backdrop-filter: var(--popup-surface-blur);
}
.popup-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px; }
.popup-title { font-size: 13px; font-weight: 700; color: var(--content-primary); }
.popup-actions { display: flex; gap: 6px; justify-content: flex-end; align-items: center; margin-top: 2px; }
.popup-delete {
  padding: 5px 12px; border-radius: var(--danger-button-radius); border: 1px solid var(--danger-button-border);
  background: var(--danger-button-bg); color: var(--danger-button-fg);
  font-size: 12px; cursor: pointer; font-family: var(--font-sans); font-weight: 600;
  box-shadow: var(--danger-button-shadow);
  transition: background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard);
}
.popup-delete:hover { background: var(--danger-button-bg-hover); border-color: var(--danger-button-border-hover); }
.popup-save {
  padding: 5px 14px; border-radius: var(--radius-xs); border: none;
  background: var(--action-primary-bg); color: var(--content-on-accent);
  font-size: 12px; font-weight: 600; cursor: pointer; font-family: var(--font-sans);
  transition: opacity var(--motion-hover-control) var(--motion-ease-standard); box-shadow: var(--elevation-card);
}
.popup-save:disabled { opacity: 0.38; cursor: default; }
.popup-save:not(:disabled):hover { opacity: 0.88; }
</style>

<style>
/* EventFormFields/TimeInput 可能由 Teleport 挂载；主题映射仍归活动表单组件。 */
html[data-theme][data-family] .event-form-body .popup-title { color: var(--content-primary); }
html[data-theme][data-family] .event-form-body .popup-save {
  color: var(--content-on-accent); background: var(--action-primary-bg); box-shadow: none;
}
html[data-theme][data-family] .event-form-body .popup-delete {
  color: var(--status-warning); background: var(--status-warning-bg);
  border-color: color-mix(in srgb,var(--status-warning) 30%,transparent);
}
html[data-theme][data-family] .event-form-body .popup-delete:hover {
  background: color-mix(in srgb,var(--status-warning) 20%,transparent); border-color: var(--status-warning);
}
html[data-theme][data-family] .event-form-body .time-dash,
html[data-theme][data-family] .event-form-body .allday-toggle,
html[data-theme][data-family] .event-form-body .reminder-label { color: var(--content-secondary); }
html[data-theme][data-family] .event-form-body .nextday-tag {
  color: var(--selection-fg); background: var(--selection-bg);
}
html[data-theme][data-family] .event-form-body .reminder-section { border-top-color: var(--content-divider); }
html[data-theme][data-family] .event-form-body .reminder-del { color: var(--status-warning); }
html[data-theme][data-family] .event-form-body .reminder-del:hover { background: var(--status-warning-bg); }
html[data-theme][data-family] .event-form-body .reminder-add-toggle {
  color: var(--content-secondary); background: transparent; border-color: var(--action-outline);
}
html[data-theme][data-family] .event-form-body .reminder-add-toggle:hover,
html[data-theme][data-family] .event-form-body .reminder-test-bar:hover {
  color: var(--content-primary); background: var(--action-soft-hover); border-color: var(--border-focus);
}
html[data-theme][data-family] .event-form-body .reminder-test-bar {
  color: var(--content-secondary); background: var(--action-soft); border-color: var(--action-outline);
}
html[data-theme][data-family] .event-form-body .chan-chip {
  color: var(--content-secondary); background: var(--control-bg); border-color: var(--control-border);
}
html[data-theme][data-family] .event-form-body .chan-chip.on {
  color: var(--selection-fg); background: var(--selection-bg); border-color: var(--action-outline);
}
</style>
