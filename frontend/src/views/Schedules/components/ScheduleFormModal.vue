<template>
  <BaseModal :show="props.show" width="420px" background="var(--panel-bg)" @close="emit('close')">
    <div class="sched-modal">
      <input v-model="form.name" ref="nameRef" class="title-input" :placeholder="t('schedules.taskName')" maxlength="100" />
      <div class="divider divider-full"></div>

      <label class="field">
        <span>{{ t('schedules.reminder') }}</span>
        <textarea v-model="form.payload" ref="payloadRef" rows="3" :placeholder="t('schedules.reminderPlaceholder')" @input="resizePayload"></textarea>
      </label>
      <div class="divider"></div>

      <div class="field workspace-field">
        <div class="field-heading">
          <span>{{ t('schedules.workspace') }}</span>
          <small>{{ t('schedules.workspaceHint') }}</small>
        </div>
        <AdminSelect
          v-model="workspaceSelectValue"
          class="workspace-select"
          :options="workspaceOptions"
          :placeholder="t('schedules.workspaceRoot')"
        />
      </div>
      <div v-if="props.filesystemAuthorizationEnabled" class="field authorization-field">
        <Checkbox v-model="form.filesystemAuthorized">
          {{ t('schedules.fullSandboxAccess') }}
        </Checkbox>
        <small>{{ t('schedules.fullSandboxAccessHint') }}</small>
      </div>
      <div class="divider"></div>

      <div class="field">
        <span>{{ t('schedules.repeat') }}</span>
        <div class="repeat-tabs">
          <button v-for="opt in REPEAT_OPTS" :key="opt.v" type="button" class="repeat-tab"
            :class="{ on: repeatMode === opt.v }" @click="setRepeatMode(opt.v)">{{ opt.label }}</button>
        </div>
        <div v-if="repeatMode === 'interval'" class="interval-presets">
            <button v-for="minutes in INTERVAL_PRESETS" :key="minutes" type="button" class="interval-preset"
            :class="{ on: intervalPreset === String(minutes) }" @click="selectIntervalPreset(minutes)">{{ minutes }}{{ t('schedules.intervalUnit') }}</button>
          <button type="button" class="interval-preset" :class="{ on: intervalPreset === 'custom' }"
            @click="selectIntervalPreset('custom')">{{ t('schedules.custom') }}</button>
          </div>
      </div>
      <div class="divider"></div>

      <label v-if="repeatMode !== 'once' && (repeatMode !== 'interval' || intervalPreset === 'custom')" class="field time-field">
        <span>{{ repeatMode === 'interval' ? t('schedules.minutes') : t('schedules.time') }}</span>
        <input v-if="repeatMode === 'interval' && intervalPreset === 'custom'" v-model.number="intervalMinutes" type="number" min="1" max="60" step="1" :placeholder="t('scheduleUi.intervalPlaceholder')" />
        <TimeInput v-else v-model="form.time" />
      </label>
      <div v-if="repeatMode !== 'once' && (repeatMode !== 'interval' || intervalPreset === 'custom')" class="divider"></div>

      <div v-if="repeatMode === 'once'" class="field once-field" data-testid="schedule-once-boundary">
        <div class="field-heading">
          <span>{{ t('schedules.onceAt') }}</span>
          <small>{{ t('schedules.onceHint') }}</small>
        </div>
        <div class="once-controls">
          <DatePicker :model-value="startDate" :placeholder="t('schedules.selectDate')" :show-clear="false"
            @update:model-value="setStartDate" />
          <TimeInput :model-value="startTime" @update:model-value="setStartTime" />
          <button v-if="startDate || startTime" type="button" class="boundary-clear"
            :aria-label="t('schedules.clearBoundary')" @click="clearStart">×</button>
        </div>
      </div>

      <div v-if="repeatMode !== 'once'" class="field schedule-window-field">
        <div class="field-heading">
          <span>{{ t('schedules.scheduleWindow') }}</span>
          <small>{{ t('schedules.scheduleWindowHint') }}</small>
        </div>
        <div class="boundary-row" data-testid="schedule-start-boundary">
          <span class="boundary-label">{{ t('schedules.startAt') }}</span>
          <div class="boundary-controls">
            <DatePicker :model-value="startDate" :placeholder="t('schedules.selectDate')" :show-clear="false"
              @update:model-value="setStartDate" />
            <TimeInput :model-value="startTime" @update:model-value="setStartTime" />
            <button v-if="startDate || startTime" type="button" class="boundary-clear"
              :aria-label="t('schedules.clearBoundary')" @click="clearStart">×</button>
          </div>
        </div>
        <div class="boundary-row" data-testid="schedule-end-boundary">
          <span class="boundary-label">{{ t('schedules.endAt') }}</span>
          <div class="boundary-controls">
            <DatePicker :model-value="endDate" :placeholder="t('schedules.selectDate')" :show-clear="false"
              @update:model-value="setEndDate" />
            <TimeInput :model-value="endTime" @update:model-value="setEndTime" />
            <button v-if="endDate || endTime" type="button" class="boundary-clear"
              :aria-label="t('schedules.clearBoundary')" @click="clearEnd">×</button>
          </div>
        </div>
      </div>
      <div v-if="repeatMode !== 'once'" class="divider"></div>

      <div class="field">
        <span>{{ t('schedules.sendTo') }}</span>
        <div class="chans">
          <template v-for="channel in CHANNELS" :key="channel.value">
            <Checkbox v-if="channel.value === 'web' || channel.value === 'email' || props.imChannels.includes(channel.value)"
              :model-value="form.channels.includes(channel.value)"
              @update:model-value="toggleChannel(channel.value, $event)">
              {{ channel.label }}
            </Checkbox>
          </template>
        </div>
      </div>

        <div v-if="formErr || props.externalError" class="form-err">{{ formErr || props.externalError }}</div>
      <div class="modal-actions">
        <ActionButton variant="secondary" @click="emit('close')">{{ t('schedules.cancel') }}</ActionButton>
        <ActionButton :disabled="props.busy" @click="submit">{{ props.task ? t('schedules.save') : t('schedules.createAction') }}</ActionButton>
      </div>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch, type PropType } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseModal from '@/components/common/overlays/BaseModal.vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import Checkbox from '@/components/common/controls/Checkbox.vue'
import DatePicker from '@/components/common/controls/DatePicker.vue'
import TimeInput from '@/components/common/controls/TimeInput.vue'
import AdminSelect from '@/components/AdminSelect.vue'
import {
  buildCron,
  combineScheduleDateTime,
  parseCron,
  scheduleDateTimeValue,
  splitScheduleDateTime,
  type RepeatMode,
} from '../utils/scheduleCron'

const props = defineProps({
  show: { type: Boolean, default: false },
  task: { type: Object as PropType<Record<string, any> | null>, default: null },
  imChannels: { type: Array as PropType<string[]>, default: () => [] },
  workspaces: { type: Array as PropType<Array<{ id: number; name: string }>>, default: () => [] },
  busy: { type: Boolean, default: false },
  externalError: { type: String, default: '' },
  filesystemAuthorizationEnabled: { type: Boolean, default: false },
})
const emit = defineEmits<{
  (event: 'close'): void
  (event: 'save', data: Record<string, any>): void
}>()
const { t } = useI18n()

const REPEAT_OPTS = computed<{ v: RepeatMode; label: string }[]>(() => [
  { v: 'once', label: t('schedules.once') }, { v: 'interval', label: t('schedules.minutes') }, { v: 'daily', label: t('schedules.daily') },
  { v: 'weekday', label: t('schedules.weekday') }, { v: 'weekend', label: t('schedules.weekend') },
])
const INTERVAL_PRESETS = [1, 5, 10, 30, 60]
const CHANNELS = computed(() => [
  { value: 'web', label: t('schedules.webNotice') },
  { value: 'email', label: t('schedules.email') },
  { value: 'feishu', label: t('schedules.feishu') },
  { value: 'qq', label: t('schedules.qq') },
  { value: 'wechat', label: t('schedules.wechat') },
])
const workspaceOptions = computed(() => [
  { value: '', label: t('schedules.workspaceRoot') },
  ...props.workspaces.map(workspace => ({ value: String(workspace.id), label: workspace.name })),
])
const repeatMode = ref<RepeatMode>('daily')
const intervalMinutes = ref(5)
const intervalPreset = ref('5')
const startDate = ref('')
const startTime = ref('')
const endDate = ref('')
const endTime = ref('')
const formErr = ref('')
const nameRef = ref<HTMLInputElement | null>(null)
const payloadRef = ref<HTMLTextAreaElement | null>(null)
const form = reactive({
  name: '', payload: '', time: '09:00', channels: ['web'] as string[],
  workspaceId: null as number | null, filesystemAuthorized: false,
})
const workspaceSelectValue = computed({
  get: () => form.workspaceId === null ? '' : String(form.workspaceId),
  set: (value: string) => { form.workspaceId = value ? Number(value) : null },
})

function pad(value: number) { return String(value).padStart(2, '0') }
function todayIso() {
  const date = new Date()
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
function onceDefault() {
  const date = new Date()
  date.setSeconds(0, 0)
  date.setMinutes(date.getMinutes() + 5)
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  }
}
function blankForm() {
  return {
    name: '', payload: '', time: '09:00', channels: ['web'] as string[],
    workspaceId: null as number | null, filesystemAuthorized: false,
  }
}
function filterChannels(channels: string[]) {
  const allowed = ['web', 'email', ...props.imChannels]
  const filtered = channels.filter(channel => allowed.includes(channel))
  return filtered.length ? filtered : ['web']
}
function resetForm() {
  const parsed = props.task ? parseCron(props.task.cron) : { mode: 'daily' as RepeatMode, time: '09:00' }
  const taskKind = props.task?.schedule_kind
  const channels: string[] = props.task
    ? [...new Set<string>((props.task.channels || []).flatMap((channel: string) =>
      channel === 'chat' ? ['web'] : channel === 'im' ? ['feishu', 'qq', 'wechat'] : [channel]))]
    : ['web']
  Object.assign(form, props.task
    ? { name: props.task.name, payload: props.task.payload, time: parsed.time, channels: filterChannels(channels) }
    : blankForm())
  repeatMode.value = taskKind === 'once' ? 'once' : (taskKind === 'interval' ? 'interval' : parsed.mode)
  intervalMinutes.value = parsed.intervalMinutes ?? 5
  intervalPreset.value = INTERVAL_PRESETS.includes(intervalMinutes.value) ? String(intervalMinutes.value) : 'custom'
  const start = splitScheduleDateTime(props.task?.start_at)
  const end = splitScheduleDateTime(props.task?.end_at)
  startDate.value = start.date
  startTime.value = start.time
  endDate.value = end.date
  endTime.value = end.time
  form.workspaceId = props.task?.workspace_id ?? null
  form.filesystemAuthorized = Boolean(props.task?.filesystem_authorized)
  formErr.value = ''
  nextTick(() => { nameRef.value?.focus(); resizePayload() })
}
watch(() => props.show, show => { if (show) resetForm() })
function resizePayload() {
  const element = payloadRef.value
  if (!element) return
  element.style.height = 'auto'
  const min = 96
  const max = 160
  element.style.height = `${Math.min(max, Math.max(min, element.scrollHeight))}px`
  element.style.overflowY = element.scrollHeight > max ? 'auto' : 'hidden'
}
function selectIntervalPreset(value: number | 'custom') {
  intervalPreset.value = String(value)
  if (value !== 'custom') intervalMinutes.value = value
}
function setRepeatMode(mode: RepeatMode) {
  if (mode === 'once') {
    const fallback = onceDefault()
    if (!startDate.value) startDate.value = fallback.date
    if (!startTime.value) startTime.value = fallback.time
    endDate.value = ''
    endTime.value = ''
  } else if (repeatMode.value === 'once') {
    startDate.value = ''
    startTime.value = ''
  }
  repeatMode.value = mode
}
function setStartDate(value: string) {
  startDate.value = value
  if (value && !startTime.value) startTime.value = repeatMode.value === 'interval' ? '09:00' : form.time
}
function setStartTime(value: string) {
  startTime.value = value
  if (value && !startDate.value) startDate.value = todayIso()
}
function setEndDate(value: string) {
  endDate.value = value
  if (value && !endTime.value) endTime.value = '23:59'
}
function setEndTime(value: string) {
  endTime.value = value
  if (value && !endDate.value) endDate.value = todayIso()
}
function clearStart() {
  startDate.value = ''
  startTime.value = ''
}
function clearEnd() {
  endDate.value = ''
  endTime.value = ''
}
function toggleChannel(channel: string, checked: boolean) {
  const channels = new Set(form.channels)
  if (checked) channels.add(channel)
  else channels.delete(channel)
  form.channels = [...channels]
}
function submit() {
  if (!form.name.trim()) { formErr.value = t('schedules.nameRequired'); return }
  if (!form.channels.length) { formErr.value = t('schedules.channelRequired'); return }
  if (repeatMode.value === 'once') {
    const startAt = combineScheduleDateTime(startDate.value, startTime.value)
    if (!startAt) { formErr.value = t('schedules.boundaryIncomplete'); return }
    const startValue = scheduleDateTimeValue(startDate.value, startTime.value)
    if (startValue !== null && startValue <= Date.now()) { formErr.value = t('scheduleUi.onceInPast'); return }
    formErr.value = ''
    emit('save', {
      name: form.name.trim(), payload: form.payload,
      schedule_kind: 'once', cron: null, interval_minutes: null,
      start_at: startAt, end_at: null,
      channels: [...form.channels], enabled: props.task ? props.task.enabled : true,
      workspace_id: form.workspaceId,
      filesystem_authorized: form.filesystemAuthorized,
    })
    return
  }
  {
    const startAt = combineScheduleDateTime(startDate.value, startTime.value)
    const endAt = combineScheduleDateTime(endDate.value, endTime.value)
    if ((startDate.value || startTime.value) && !startAt) { formErr.value = t('schedules.boundaryIncomplete'); return }
    if ((endDate.value || endTime.value) && !endAt) { formErr.value = t('schedules.boundaryIncomplete'); return }
    const startValue = scheduleDateTimeValue(startDate.value, startTime.value)
    const endValue = scheduleDateTimeValue(endDate.value, endTime.value)
    if (startValue !== null && endValue !== null && endValue < startValue) {
      formErr.value = t('schedules.endBeforeStart')
      return
    }
    formErr.value = ''
    const scheduleKind = repeatMode.value === 'interval' ? 'interval' : 'cron'
    emit('save', {
      name: form.name.trim(), payload: form.payload,
      schedule_kind: scheduleKind,
      cron: scheduleKind === 'cron' ? buildCron({ mode: repeatMode.value, time: form.time }) : null,
      interval_minutes: scheduleKind === 'interval' ? intervalMinutes.value : null,
      start_at: startAt,
      end_at: endAt,
      channels: [...form.channels], enabled: props.task ? props.task.enabled : true,
      workspace_id: form.workspaceId,
      filesystem_authorized: form.filesystemAuthorized,
    })
  }
}
</script>

<style scoped>
/* 全套表面/边框/选中态消费语义 token（--input-* / --option-* / --action-*），与
   TimeInput.boxed、活动弹窗输入框同一契约，亮暗主题自动适配；
   亮色下这些 token 的原始值与旧硬编码（黑 10% 描边、白 72% 底、品牌紫渐变）几乎一致。 */
.sched-modal { padding: 16px 18px; }
.divider { height: 1px; background: var(--divider-line); margin: 2px 0 10px; }
.divider-full { margin-left: -18px; margin-right: -18px; background: color-mix(in srgb, var(--content-primary) 8%, transparent); }
.title-input { width: 100%; box-sizing: border-box; outline: none; font-size: 16px; font-weight: 700; color: var(--text-primary); font-family: var(--font-sans); padding: 6px 11px; margin-bottom: 10px; border: 1px solid var(--input-border); border-radius: var(--radius-sm); background: var(--input-bg); transition: border-color 0.15s, box-shadow 0.15s; }
.title-input::placeholder { color: var(--input-placeholder); font-weight: 700; }
.title-input:focus { border-color: var(--input-border-focus); box-shadow: var(--input-focus-shadow); }
.field { display: block; margin-bottom: 11px; }
.field > span { display: block; font-size: 12px; font-weight: 700; color: var(--text-secondary); margin-bottom: 6px; }
.field-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 7px; }
.field-heading > span { font-size: 12px; font-weight: 700; color: var(--text-secondary); }
  .field-heading small { color: var(--content-tertiary); font-size: 11px; text-align: right; }
.workspace-select { display: block; width: 100%; margin-bottom: 7px; }
.workspace-select :deep(.asel-trigger) { width: 100%; box-sizing: border-box; }
.authorization-field > small { display: block; margin-top: 5px; color: var(--content-tertiary); font-size: 11px; line-height: 1.45; }
.authorization-field { padding: 9px 10px; border: 1px solid var(--option-border); border-radius: var(--radius-sm); background: var(--option-bg); }
.authorization-field :deep(.app-checkbox) { margin: 0; }
.once-controls { display: grid; grid-template-columns: minmax(0, 1fr) 82px 24px; align-items: center; gap: 6px; }
.once-controls :deep(.dp-wrap), .once-controls :deep(.time-input) { min-width: 0; }
.once-controls :deep(.dp-input) { min-width: 0; min-height: 34px; padding-left: 7px; padding-right: 7px; }
.once-controls :deep(.dp-input span) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.boundary-row { display: grid; grid-template-columns: 58px minmax(0, 1fr); align-items: center; gap: 8px; margin-top: 7px; }
.boundary-label { color: var(--text-secondary); font-size: 12px; white-space: nowrap; }
.boundary-controls { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) 82px 24px; align-items: center; gap: 6px; }
.boundary-controls :deep(.dp-wrap) { min-width: 0; }
.boundary-controls :deep(.dp-input) { min-width: 0; min-height: 34px; padding-left: 7px; padding-right: 7px; }
.boundary-controls :deep(.dp-input span) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.boundary-controls :deep(.time-input) { min-width: 0; }
.boundary-clear { width: 24px; height: 24px; padding: 0; border: 0; border-radius: 50%; background: var(--option-bg); color: var(--text-secondary); cursor: pointer; font-size: 17px; line-height: 1; }
.boundary-clear:hover { background: var(--option-bg-hover); color: var(--text-primary); }
.field input[type=text], .field input:not([type]), .field textarea, .field select, .field input[type=number] { width: 100%; box-sizing: border-box; padding: 8px 11px; border: 1px solid var(--input-border); border-radius: var(--radius-sm); background: var(--input-bg); font-size: 13px; font-family: var(--font-sans); color: var(--text-primary); outline: none; transition: border-color 0.15s, box-shadow 0.15s; }
.field input:focus, .field textarea:focus, .field select:focus { border-color: var(--input-border-focus); box-shadow: var(--input-focus-shadow); }
.field textarea { min-height: 96px; max-height: 160px; resize: none; line-height: 1.6; overflow-y: hidden; }
.repeat-tabs { display: flex; gap: 6px; }
.repeat-tab { flex: 1; height: 34px; padding: 0; display: flex; align-items: center; justify-content: center; border-radius: var(--radius-sm); border: 1px solid var(--option-border); background: var(--option-bg); font-size: 13px; font-family: var(--font-sans); color: var(--option-fg); cursor: pointer; transition: all 0.15s; text-align: center; }
.repeat-tab:hover { border-color: var(--option-border-hover); }
.repeat-tab.on { background: var(--action-primary-bg); color: var(--content-on-accent); border-color: transparent; }
.time-field input { height: 34px; padding-top: 8px; padding-bottom: 8px; text-align: center; line-height: normal; font-size: 13px; }
.interval-presets { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 6px; margin-top: 8px; }
.interval-preset { width: 100%; min-width: 0; height: 34px; padding: 0; border-radius: var(--radius-sm); border: 1px solid var(--option-border); background: var(--option-bg); color: var(--option-fg); font-size: 12px; font-family: var(--font-sans); cursor: pointer; transition: all 0.15s; }
.interval-preset:hover { border-color: var(--option-border-hover); }
.interval-preset.on { color: var(--content-on-accent); border-color: transparent; background: var(--action-primary-bg); }
.chans { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
.chans :deep(.app-checkbox) { min-width: 0; }
.chans :deep(.app-checkbox__label) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.form-err { color: var(--status-danger); font-size: 12px; margin-bottom: 10px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 12px; align-items: center; margin-top: 6px; }
.modal-actions > button { width: 64px; min-height: 34px; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; white-space: nowrap; }
.link { background: none; border: none; cursor: pointer; font-size: 12px; color: var(--text-secondary); padding: 2px 3px; font-family: var(--font-sans); }
.link:hover { color: var(--text-primary); }
@media (max-width: 460px) {
  .sched-modal { padding-left: 12px; padding-right: 12px; }
  .boundary-row { grid-template-columns: 1fr; gap: 4px; }
  .boundary-controls { grid-template-columns: minmax(0, 1fr) 78px 24px; }
  .field-heading { display: block; }
  .field-heading small { display: block; margin-top: 3px; text-align: left; }
}
</style>
