<!-- 活动表单的字段部分（名称/日期/全天/时间段/描述/提醒），从 Calendar/index.vue 抽出来，
     好让新建活动和全局编辑弹窗共用同一份字段和提醒逻辑。
     外壳（浮层定位 / 居中弹窗、标题栏、保存删除按钮）留在各自的调用方，这里只管字段本身。 -->
<template>
  <input v-model="event.name" class="popup-input" placeholder="活动名称"
         v-enter="() => emit('save')" @keydown.esc="emit('close')" :autofocus="autofocus" />
  <div class="date-row">
    <DatePicker class="date-row-picker" v-model="event.date" placeholder="选择日期" />
    <label class="allday-toggle">
      <input type="checkbox" v-model="event.allDay" @change="onToggleAllDay(event)" />
      全天
    </label>
  </div>
  <div class="time-box" v-if="!event.allDay">
    <TimeInput v-model="event.time" :boxed="false" />
    <span class="time-dash">—</span>
    <TimeInput v-model="event.endTime" :boxed="false" />
    <span v-if="isNextDay(event.time, event.endTime)" class="nextday-tag">次日</span>
  </div>
  <textarea v-model="event.description" class="popup-textarea" placeholder="描述（可选）" rows="2"></textarea>
  <div class="reminder-section" v-if="!isPastDate(event.date)">
    <div class="reminder-label"><PhBell :size="11" weight="bold" /> 提醒</div>
    <div v-for="(r, i) in form.reminders.value" :key="i" class="reminder-item">
      <select v-model.number="r.leadMin" class="lead-select">
        <option v-for="o in LEAD_OPTIONS" :key="o.min" :value="o.min">{{ o.label }}</option>
      </select>
      <button class="reminder-del" @click="form.removeReminderAt(i)" title="移除"><PhX :size="10" weight="bold" /></button>
    </div>
    <button class="reminder-add-toggle" @click="form.addReminder">＋ 添加提醒</button>
    <div class="chan-block" v-if="form.reminders.value.length">
      <div class="reminder-label">渠道</div>
      <div class="chan-chips">
        <button class="chan-chip" :class="{ on: form.reminderChannels.value.includes('web') }" @click="form.toggleReminderChannel('web')">web</button>
        <button v-for="ch in form.imChannels.value" :key="ch" class="chan-chip" :class="{ on: form.reminderChannels.value.includes(ch) }" @click="form.toggleReminderChannel(ch)">{{ CHAN_LABEL[ch] || ch }}</button>
      </div>
      <button class="reminder-test-bar" @click="emit('test-reminder')"><PhPaperPlaneTilt :size="11" weight="bold" /> 测试发送</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { PhBell, PhPaperPlaneTilt, PhX } from '@phosphor-icons/vue'
import DatePicker from '@/components/common/DatePicker.vue'
import TimeInput from '@/components/common/TimeInput.vue'
import {
  LEAD_OPTIONS, CHAN_LABEL, isNextDay, onToggleAllDay,
  type EventDraft, type useEventEditForm,
} from '@/composables/useEventEditForm'

defineProps<{
  event: EventDraft
  form: ReturnType<typeof useEventEditForm>
  autofocus?: boolean
  isPastDate: (d: string | null | undefined) => boolean
}>()
const emit = defineEmits<{ (e: 'save'): void; (e: 'close'): void; (e: 'test-reminder'): void }>()
</script>

<style scoped>
.date-row { display: flex; align-items: center; gap: 8px; }
.date-row-picker { flex: 1; min-width: 0; }
.allday-toggle {
  display: flex; align-items: center; gap: 6px; flex-shrink: 0;
  font-size: 12.5px; color: var(--content-secondary); cursor: pointer; user-select: none; white-space: nowrap;
}
/* The global checkbox keeps the legacy registration/task-list shape, but its light paper fill is
   too bright inside a dark event editor. This component maps that same control to the shared
   option/action contract without introducing another global checkbox override layer. */
.allday-toggle input[type="checkbox"] {
  background: var(--option-bg);
  border-color: var(--option-border);
  transition:
    background-color var(--motion-hover-control) var(--motion-ease-standard),
    border-color var(--motion-hover-control) var(--motion-ease-standard),
    box-shadow var(--motion-hover-control) var(--motion-ease-standard);
}
.allday-toggle input[type="checkbox"]:hover {
  background: var(--option-bg-hover);
  border-color: var(--option-border-hover);
}
.allday-toggle input[type="checkbox"]:checked {
  background: var(--action-primary-bg);
  border-color: transparent;
  box-shadow: var(--elevation-card);
}
.time-box,
.popup-input,
.popup-textarea,
.lead-select {
  color: var(--input-fg);
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  outline: none;
  box-sizing: border-box;
  font-family: var(--font-sans);
  transition:
    background-color var(--motion-hover-control) var(--motion-ease-standard),
    border-color var(--motion-hover-control) var(--motion-ease-standard),
    box-shadow var(--motion-hover-control) var(--motion-ease-standard),
    color var(--motion-hover-control) var(--motion-ease-standard);
}
.time-box:hover,
.popup-input:hover,
.popup-textarea:hover,
.lead-select:hover {
  background: var(--input-bg-hover);
  border-color: var(--input-border-hover);
  box-shadow: var(--input-hover-shadow);
}
.time-box:focus-within,
.popup-input:focus,
.popup-textarea:focus,
.lead-select:focus {
  background: var(--input-bg-focus);
  border-color: var(--input-border-focus);
  box-shadow: var(--input-focus-shadow);
}
.time-box {
  position: relative; display: flex; align-items: center; justify-content: center; gap: 4px;
  width: 100%; padding: 8px 11px; border-radius: var(--input-radius);
}
.time-dash { color: var(--content-tertiary); font-size: 12px; font-weight: 600; }
.nextday-tag {
  position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
  font-size: 10px; font-weight: 600; color: var(--selection-fg); background: var(--selection-bg);
  padding: 1px 6px; border-radius: var(--radius-xs); white-space: nowrap; pointer-events: none;
}
.popup-input { width: 100%; padding: 8px 11px; border-radius: var(--input-radius); font-size: 13px; }
.popup-textarea {
  width: 100%; padding: 8px 11px; border-radius: var(--input-radius); font-size: 13px;
  resize: none; line-height: 1.5;
}
.popup-input::placeholder,
.popup-textarea::placeholder { color: var(--input-placeholder); }
.reminder-section {
  display: flex; flex-direction: column; gap: 6px; padding-top: 7px;
  border-top: 1px solid var(--panel-divider);
}
.reminder-label { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; color: var(--content-secondary); }
.reminder-item { display: flex; align-items: center; gap: 6px; }
.reminder-del {
  display: flex; align-items: center; padding: 3px; border: none; border-radius: var(--radius-xs);
  background: transparent; cursor: pointer; color: var(--danger-button-fg);
  transition: background-color var(--motion-hover-control) var(--motion-ease-standard);
}
.reminder-del:hover { background: var(--danger-button-bg); }
.reminder-add-toggle,
.reminder-test-bar {
  width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: var(--radius-sm);
  color: var(--option-fg); font-size: 11px; font-weight: 600; cursor: pointer; font-family: var(--font-sans);
  transition:
    color var(--motion-hover-control) var(--motion-ease-standard),
    background-color var(--motion-hover-control) var(--motion-ease-standard),
    border-color var(--motion-hover-control) var(--motion-ease-standard);
}
.reminder-add-toggle { text-align: center; border: 1px dashed var(--action-outline); background: transparent; }
.reminder-test-bar {
  display: flex; align-items: center; justify-content: center; gap: 5px; margin-top: 7px;
  border: 1px solid var(--option-border); background: var(--option-bg);
}
.reminder-add-toggle:hover,
.reminder-test-bar:hover {
  color: var(--option-fg-hover); background: var(--option-bg-hover); border-color: var(--option-border-hover);
}
.chan-block { display: flex; flex-direction: column; gap: 5px; }
.chan-chips { display: flex; gap: 5px; flex-wrap: wrap; }
.chan-chip {
  padding: 3px 11px; border-radius: var(--choice-chip-radius); border: 1px solid var(--choice-chip-border);
  background: var(--choice-chip-bg); color: var(--choice-chip-fg);
  font-size: 11px; font-weight: 600; cursor: pointer; font-family: var(--font-sans);
  transition:
    color var(--motion-hover-control) var(--motion-ease-standard),
    background-color var(--motion-hover-control) var(--motion-ease-standard),
    border-color var(--motion-hover-control) var(--motion-ease-standard);
}
.chan-chip:hover { color: var(--choice-chip-fg-hover); background: var(--choice-chip-bg-hover); border-color: var(--choice-chip-border-hover); }
.chan-chip.on { color: var(--choice-chip-fg-active); background: var(--choice-chip-bg-active); border-color: var(--choice-chip-border-active); }
.lead-select { flex: 1; padding: 5px 8px; border-radius: var(--radius-xs); font-size: 12px; }
</style>
