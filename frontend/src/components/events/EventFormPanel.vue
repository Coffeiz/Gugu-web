<template>
  <div class="event-form-body">
    <div class="popup-header">
      <span class="popup-title">{{ title }}</span>
      <button class="popup-close-btn" @click="emit('close')" title="关闭">
        <PhX :size="12" weight="bold" />
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
import { PhX } from '@phosphor-icons/vue'
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
.event-form-body { display: flex; flex-direction: column; gap: 9px; padding: 16px; }
.popup-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px; }
.popup-title { font-size: 13px; font-weight: 700; color: #1e2028; }
.popup-close-btn { display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: none; border-radius: 6px; background: none; color: var(--text-secondary); cursor: pointer; }
.popup-close-btn:hover { background: rgba(0,0,0,0.06); }
.popup-actions { display: flex; gap: 6px; justify-content: flex-end; align-items: center; margin-top: 2px; }
.popup-delete { padding: 5px 12px; border-radius: 8px; border: 1px solid rgba(176,120,88,0.3); background: rgba(176,120,88,0.08); font-size: 12px; cursor: pointer; color: #b07858; font-family: 'PingFang SC', 'Segoe UI', sans-serif; font-weight: 600; transition: background 0.12s, border-color 0.12s; }
.popup-delete:hover { background: rgba(176,120,88,0.15); border-color: rgba(176,120,88,0.5); }
.popup-save { padding: 5px 14px; border-radius: 8px; border: none; background: linear-gradient(135deg,#7b7fb2,#9590c4); color: white; font-size: 12px; font-weight: 600; cursor: pointer; font-family: 'PingFang SC', 'Segoe UI', sans-serif; transition: opacity 0.15s; box-shadow: 0 2px 8px rgba(123,127,178,0.28); }
.popup-save:disabled { opacity: 0.38; cursor: default; }
.popup-save:not(:disabled):hover { opacity: 0.88; }
</style>
