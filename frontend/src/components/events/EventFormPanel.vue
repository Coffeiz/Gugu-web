<template>
  <div class="event-form-body">
    <div class="popup-header">
      <span class="popup-title">{{ title }}</span>
      <button class="popup-close-btn" @click="emit('close')" title="关闭">
        <Icon name="action.close" :size="12" />
      </button>
    </div>
    <EventFormFields :event="event" :form="form" :is-past-date="isPastDate" :autofocus="autofocus"
                     @save="emit('save')" @close="emit('close')" @test-reminder="emit('test-reminder')" />
    <div class="popup-actions">
      <button class="popup-save" @click="emit('save')" :disabled="!event.name">保存</button>
      <button v-if="showDelete" class="popup-delete" @click="emit('delete')">删除</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import Icon from '@/components/common/Icon.vue'
import EventFormFields from './EventFormFields.vue'
import { type EventDraft, type useEventEditForm } from '@/composables/useEventEditForm'

withDefaults(defineProps<{
  event: EventDraft
  form: ReturnType<typeof useEventEditForm>
  isPastDate: (date: string | null | undefined) => boolean
  title?: string
  showDelete?: boolean
  autofocus?: boolean
}>(), { title: '编辑活动', showDelete: false })

const emit = defineEmits<{
  save: []
  close: []
  delete: []
  'test-reminder': []
}>()
</script>

<style scoped>
.event-form-body { display: flex; flex-direction: column; gap: 9px; padding: 16px; color: var(--content-primary); }
.popup-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px; }
.popup-title { font-size: 13px; font-weight: 700; color: var(--content-primary); }
.popup-close-btn {
  display: flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; border: none; border-radius: var(--radius-xs);
  background: transparent; color: var(--content-secondary); cursor: pointer;
  transition: background-color var(--motion-hover-control) var(--motion-ease-standard), color var(--motion-hover-control) var(--motion-ease-standard);
}
.popup-close-btn:hover { background: var(--surface-soft-hover); color: var(--content-primary); }
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
  padding: 5px 14px; border-radius: var(--radius-sm); border: none;
  background: var(--action-primary-bg); color: var(--content-on-accent);
  font-size: 12px; font-weight: 600; cursor: pointer; font-family: var(--font-sans);
  transition: opacity var(--motion-hover-control) var(--motion-ease-standard); box-shadow: var(--elevation-card);
}
.popup-save:disabled { opacity: 0.38; cursor: default; }
.popup-save:not(:disabled):hover { opacity: 0.88; }
</style>
