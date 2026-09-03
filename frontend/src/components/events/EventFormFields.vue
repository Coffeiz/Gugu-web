<!-- 活动表单的字段部分（名称/日期/全天/时间段/描述/提醒），从 Calendar/index.vue 抽出来，
     好让新建活动和全局编辑弹窗共用同一份字段和提醒逻辑。
     外壳（浮层定位 / 居中弹窗、标题栏、保存删除按钮）留在各自的调用方，这里只管字段本身。 -->
<template>
  <input v-model="event.name" class="popup-input" :placeholder="t('calendar.eventName')"
         v-enter="() => emit('save')" @keydown.esc="emit('close')" :autofocus="autofocus" />
  <div class="date-row">
    <DatePicker class="date-row-picker" v-model="event.date" :placeholder="t('sharedUi.chooseDate')" />
    <Checkbox v-model="event.allDay" class="allday-toggle" @update:model-value="onToggleAllDay(event)">
      {{ t('calendar.allDay') }}
    </Checkbox>
  </div>
  <div class="time-box" v-if="!event.allDay">
    <TimeInput v-model="event.time" :boxed="false" />
    <span class="time-dash">—</span>
    <TimeInput v-model="event.endTime" :boxed="false" />
    <span v-if="isNextDay(event.time, event.endTime)" class="nextday-tag">{{ t('calendar.nextDay') }}</span>
  </div>
  <textarea
    v-model="event.description"
    class="popup-textarea"
    :placeholder="t('calendar.descriptionOptional')"
    rows="2"
    :ref="mountAutoGrow"
    @input="autoGrow($event.target)"
  ></textarea>
  <div class="reminder-section" v-if="!isPastDate(event.date)">
    <div class="reminder-label"><Icon name="admin.bell" :size="11" /> {{ t('calendar.reminder') }}</div>
    <div v-for="(r, i) in form.reminders.value" :key="i" class="reminder-item">
      <button
        :ref="el => setLeadAnchor(i, el)"
        class="lead-select lead-trigger"
        type="button"
        @click.stop="toggleLeadMenu(i)"
      >
        {{ leadLabelOf(r.leadMin) }}
        <FlipChevron :open="leadMenuIndex === i" />
      </button>
      <!-- 与排序菜单同源：标准列表弹窗（Teleport 到 body），替代原生 select -->
      <ContextMenu
        :show="leadMenuIndex === i"
        :anchor="leadAnchorEl"
        :x="leadMenuPos.x"
        :y="leadMenuPos.y"
        @close="closeLeadMenu"
      >
        <button
          v-for="o in LEAD_OPTIONS"
          :key="o.min"
          class="ctx-item popup-menu-item lead-menu-item"
          :class="{ active: o.min === form.reminders.value[leadMenuIndex]?.leadMin }"
          type="button"
          @click="pickLead(o.min)"
        >
          {{ o.label }}
        </button>
      </ContextMenu>
      <button class="reminder-del" @click="form.removeReminderAt(i)" :title="t('common.actions.remove')"><Icon name="action.close" :size="10" /></button>
    </div>
    <button class="reminder-add-toggle" @click="form.addReminder">＋ {{ t('calendar.addReminder') }}</button>
    <div class="chan-block" v-if="form.reminders.value.length">
      <div class="reminder-label">{{ t('calendar.channel') }}</div>
      <div class="chan-chips">
        <button class="chan-chip" :class="{ on: form.reminderChannels.value.includes('web') }" @click="form.toggleReminderChannel('web')">web</button>
        <button v-for="ch in form.imChannels.value" :key="ch" class="chan-chip" :class="{ on: form.reminderChannels.value.includes(ch) }" @click="form.toggleReminderChannel(ch)">{{ CHAN_LABEL[ch] || ch }}</button>
      </div>
      <button class="reminder-test-bar" @click="emit('test-reminder')"><Icon name="action.send" :size="11" /> {{ t('common.actions.testSend') }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import Icon from '@/components/common/icons/Icon.vue'
import { useI18n } from 'vue-i18n'
import Checkbox from '@/components/common/controls/Checkbox.vue'
import DatePicker from '@/components/common/controls/DatePicker.vue'
import TimeInput from '@/components/common/controls/TimeInput.vue'
import FlipChevron from '@/components/common/controls/FlipChevron.vue'
import ContextMenu from '@/components/common/overlays/ContextMenu.vue'
import {
  LEAD_OPTIONS, CHAN_LABEL, isNextDay, onToggleAllDay,
  type EventDraft, type useEventEditForm,
} from '@/composables/calendar/useEventEditForm'

const props = defineProps<{
  event: EventDraft
  form: ReturnType<typeof useEventEditForm>
  autofocus?: boolean
  isPastDate: (d: string | null | undefined) => boolean
}>()
const emit = defineEmits<{ (e: 'save'): void; (e: 'close'): void; (e: 'test-reminder'): void }>()
const { t } = useI18n()

// 提前量下拉：标准列表弹窗（ContextMenu + FlipChevron），替代原生 select。
// 提醒项是列表，用打开项下标区分各行的菜单状态。
const leadMenuIndex = ref(-1)
const leadAnchorEl = ref<HTMLElement | null>(null)
const leadMenuPos = ref({ x: 0, y: 0 })
const leadAnchorEls: HTMLElement[] = []

function setLeadAnchor(i: number, el: unknown) {
  if (el) leadAnchorEls[i] = el as HTMLElement
}
function leadLabelOf(min: number) {
  return LEAD_OPTIONS.find(o => o.min === min)?.label ?? `提前 ${min} 分钟`
}
function toggleLeadMenu(i: number) {
  if (leadMenuIndex.value === i) { closeLeadMenu(); return }
  const el = leadAnchorEls[i]
  if (!el) return
  const r = el.getBoundingClientRect()
  leadAnchorEl.value = el
  leadMenuPos.value = { x: r.left, y: r.bottom + 6 }
  leadMenuIndex.value = i
}
function pickLead(min: number) {
  const item = props.form.reminders.value[leadMenuIndex.value]
  if (item) item.leadMin = min
  closeLeadMenu()
}
function closeLeadMenu() { leadMenuIndex.value = -1 }

// 描述框随内容自动长高（挂载/输入时各调一次），封顶后内部滚动，不再无限撑高弹窗。
function autoGrow(el: unknown) {
  const ta = el as HTMLTextAreaElement | null
  if (!ta || !ta.isConnected) return
  ta.style.height = 'auto'
  // ref 回调可能早于首次布局，scrollHeight 为 0 时保持 rows 默认高度，别写成 0
  if (!ta.scrollHeight) return
  ta.style.height = `${Math.min(ta.scrollHeight, 176)}px`
}
// 挂载时布局尚未完成，推迟到下一帧测量（打开时已有内容也能正确撑高）
function mountAutoGrow(el: unknown) {
  if (!el) return
  requestAnimationFrame(() => autoGrow(el))
}
</script>

<style scoped>
.date-row { display: flex; align-items: center; gap: 8px; }
.date-row-picker { flex: 1; min-width: 0; }
.allday-toggle {
  display: flex; align-items: center; gap: 6px; flex-shrink: 0;
  font-size: 12.5px; color: var(--content-secondary); cursor: pointer; user-select: none; white-space: nowrap;
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
  /* 保留 hover 内描边，再叠加 focus 光晕，避免点击时从 hover 直接替换成 focus，
     导致光晕只有失焦淡出、聚焦没有淡入。 */
  box-shadow: var(--input-hover-shadow), var(--input-focus-shadow);
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
  /* autoGrow 脚本负责动态高度；这个上限只做兜底，超出后内部滚动。 */
  max-height: 176px; overflow-y: auto;
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
/* 触发器是按钮（原生 select 已移除），外观沿用输入令牌；宽度铺满提醒项剩余空间。 */
.lead-select {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: var(--radius-xs);
  font-size: 12px;
  font-weight: 400;
  cursor: pointer;
  text-align: center;
}
</style>
