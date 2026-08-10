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
.allday-toggle { display: flex; align-items: center; gap: 6px; flex-shrink: 0; font-size: 12.5px; color: var(--text-secondary); cursor: pointer; user-select: none; white-space: nowrap; }
.time-box { position: relative; display: flex; align-items: center; justify-content: center; gap: 4px; width: 100%; box-sizing: border-box; padding: 8px 11px; border-radius: 10px; border: 1px solid rgba(0,0,0,0.1); background: rgba(255,255,255,0.72); transition: border-color 0.15s, box-shadow 0.15s; }
.time-box:focus-within { border-color: rgba(123,127,178,0.55); box-shadow: 0 0 0 3px rgba(123,127,178,0.12); background: rgba(255,255,255,0.85); }
.time-dash { color: #8a8fa8; font-size: 12px; font-weight: 600; }
.nextday-tag { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); font-size: 10px; font-weight: 600; color: #9590c4; background: rgba(123,127,178,0.1); padding: 1px 6px; border-radius: 5px; white-space: nowrap; pointer-events: none; }
.popup-input { width: 100%; padding: 8px 11px; border-radius: 10px; border: 1px solid rgba(0,0,0,0.1); background: rgba(255,255,255,0.72); font-size: 13px; font-family: var(--font-sans); color: var(--text-primary); outline: none; box-sizing: border-box; transition: border-color 0.15s, box-shadow 0.15s; }
.popup-input:focus { border-color: rgba(123,127,178,0.4); box-shadow: 0 0 0 3px rgba(123,127,178,0.1); background: rgba(255,255,255,0.85); }
.popup-textarea { width: 100%; padding: 8px 11px; border-radius: 10px; border: 1px solid rgba(0,0,0,0.1); background: rgba(255,255,255,0.72); font-size: 13px; font-family: var(--font-sans); color: var(--text-primary); outline: none; box-sizing: border-box; transition: border-color 0.15s, box-shadow 0.15s; resize: none; line-height: 1.5; }
.popup-textarea:focus { border-color: rgba(123,127,178,0.4); box-shadow: 0 0 0 3px rgba(123,127,178,0.1); background: rgba(255,255,255,0.85); }
.reminder-section { display: flex; flex-direction: column; gap: 6px; padding-top: 7px; border-top: 1px solid rgba(123,127,178,0.18); }
.reminder-label { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; color: var(--text-secondary); }
.reminder-item { display: flex; align-items: center; gap: 6px; }
.reminder-del { display: flex; align-items: center; padding: 2px; border: none; background: none; cursor: pointer; color: #b07858; border-radius: 5px; }
.reminder-del:hover { background: rgba(176,120,88,0.12); }
.reminder-add-toggle { width: 100%; box-sizing: border-box; text-align: center; padding: 6px 10px; border-radius: 8px; border: 1px dashed rgba(123,127,178,0.4); background: none; color: var(--text-secondary); font-size: 11px; font-weight: 600; cursor: pointer; font-family: 'PingFang SC','Segoe UI',sans-serif; transition: all 0.12s; }
.reminder-add-toggle:hover { border-color: rgba(123,127,178,0.7); color: var(--text-primary); background: rgba(123,127,178,0.06); }
.reminder-test-bar { width: 100%; box-sizing: border-box; display: flex; align-items: center; justify-content: center; gap: 5px; margin-top: 7px; padding: 6px 10px; border-radius: 8px; border: 1px solid rgba(123,127,178,0.4); background: rgba(123,127,178,0.08); color: var(--text-secondary); font-size: 11px; font-weight: 600; cursor: pointer; font-family: 'PingFang SC','Segoe UI',sans-serif; transition: all 0.12s; }
.reminder-test-bar:hover { border-color: rgba(123,127,178,0.7); background: rgba(123,127,178,0.16); color: var(--text-primary); }
.chan-block { display: flex; flex-direction: column; gap: 5px; }
.chan-chips { display: flex; gap: 5px; flex-wrap: wrap; }
.chan-chip { padding: 3px 11px; border-radius: 99px; border: 1px solid rgba(123,127,178,0.3); background: rgba(255,255,255,0.5); color: var(--text-secondary); font-size: 11px; font-weight: 600; cursor: pointer; font-family: 'PingFang SC','Segoe UI',sans-serif; transition: all 0.12s; }
.chan-chip.on { background: rgba(123,127,178,0.16); border-color: rgba(123,127,178,0.55); color: #5b5f8c; }
.lead-select { flex: 1; padding: 5px 8px; border-radius: 7px; border: 1px solid rgba(0,0,0,0.1); background: rgba(255,255,255,0.72); font-size: 12px; font-family: var(--font-sans); color: var(--text-primary); outline: none; }
</style>
