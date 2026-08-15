<template>
  <BaseModal :show="props.show" width="420px" background="var(--panel-bg)" @close="emit('close')">
    <div class="sched-modal">
      <input v-model="form.name" ref="nameRef" class="title-input" placeholder="任务名称" maxlength="100" />
      <div class="divider divider-full"></div>

      <label class="field">
        <span>提醒内容</span>
        <textarea v-model="form.payload" ref="payloadRef" rows="3" placeholder="如：收集昨天的科技新闻" @input="resizePayload"></textarea>
      </label>
      <div class="divider"></div>

      <div class="field">
        <span>重复</span>
        <div class="repeat-tabs">
          <button v-for="opt in REPEAT_OPTS" :key="opt.v" type="button" class="repeat-tab"
            :class="{ on: repeatMode === opt.v }" @click="repeatMode = opt.v">{{ opt.label }}</button>
        </div>
        <div v-if="repeatMode === 'interval'" class="interval-presets">
          <button v-for="minutes in INTERVAL_PRESETS" :key="minutes" type="button" class="interval-preset"
            :class="{ on: intervalPreset === String(minutes) }" @click="selectIntervalPreset(minutes)">{{ minutes }}分钟</button>
          <button type="button" class="interval-preset" :class="{ on: intervalPreset === 'custom' }"
            @click="selectIntervalPreset('custom')">自定义</button>
        </div>
        <div v-if="repeatMode === 'custom'" class="date-range">
          <DatePicker v-model="customStartDate" placeholder="选择日期" />
        </div>
      </div>
      <div class="divider"></div>

      <label v-if="repeatMode !== 'interval' || intervalPreset === 'custom'" class="field time-field">
        <span>{{ repeatMode === 'interval' ? '分钟' : '时间' }}</span>
        <input v-if="repeatMode === 'interval' && intervalPreset === 'custom'" v-model.number="intervalMinutes" type="number" min="1" max="60" step="1" placeholder="例如 15" />
        <TimeInput v-else v-model="form.time" />
      </label>
      <div v-if="repeatMode !== 'interval' || intervalPreset === 'custom'" class="divider"></div>

      <div class="field">
        <span>发到哪</span>
        <div class="chans">
          <template v-for="channel in CHANNELS" :key="channel.value">
            <label v-if="channel.value === 'web' || props.imChannels.includes(channel.value)" class="chk-row">
              <input v-model="form.channels" type="checkbox" :value="channel.value" class="chk-input" />
              <span class="chk-box">
                <svg v-if="form.channels.includes(channel.value)" width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <polyline points="1.5,5 4,7.5 8.5,2.5" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </span>
              {{ channel.label }}
            </label>
          </template>
        </div>
      </div>

        <div v-if="formErr || props.externalError" class="form-err">{{ formErr || props.externalError }}</div>
      <div class="modal-actions">
        <button class="link" @click="emit('close')">取消</button>
        <button class="btn-primary" :disabled="props.busy" @click="submit">{{ props.task ? '保存' : '创建' }}</button>
      </div>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { nextTick, reactive, ref, watch, type PropType } from 'vue'
import BaseModal from '@/components/common/BaseModal.vue'
import DatePicker from '@/components/common/DatePicker.vue'
import TimeInput from '@/components/common/TimeInput.vue'
import { buildCron, parseCron, type RepeatMode } from '../utils/scheduleCron'

const props = defineProps({
  show: { type: Boolean, default: false },
  task: { type: Object as PropType<Record<string, any> | null>, default: null },
  imChannels: { type: Array as PropType<string[]>, default: () => [] },
  busy: { type: Boolean, default: false },
  externalError: { type: String, default: '' },
})
const emit = defineEmits<{
  (event: 'close'): void
  (event: 'save', data: Record<string, any>): void
}>()

const REPEAT_OPTS: { v: RepeatMode; label: string }[] = [
  { v: 'interval', label: '分钟' }, { v: 'daily', label: '每日' },
  { v: 'weekday', label: '工作日' }, { v: 'weekend', label: '周末' },
  { v: 'custom', label: '自定义' },
]
const INTERVAL_PRESETS = [1, 5, 10, 30, 60]
const CHANNELS = [
  { value: 'web', label: 'web 通知' },
  { value: 'feishu', label: '飞书' },
  { value: 'qq', label: 'QQ' },
  { value: 'wechat', label: '微信' },
]
const repeatMode = ref<RepeatMode>('daily')
const customStartDate = ref('')
const intervalMinutes = ref(5)
const intervalPreset = ref('5')
const formErr = ref('')
const nameRef = ref<HTMLInputElement | null>(null)
const payloadRef = ref<HTMLTextAreaElement | null>(null)
const form = reactive({ name: '', payload: '', time: '09:00', channels: ['web'] as string[] })

function pad(value: number) { return String(value).padStart(2, '0') }
function todayIso() {
  const date = new Date()
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
function blankForm() { return { name: '', payload: '', time: '09:00', channels: ['web'] as string[] } }
function filterChannels(channels: string[]) {
  const allowed = ['web', ...props.imChannels]
  const filtered = channels.filter(channel => allowed.includes(channel))
  return filtered.length ? filtered : ['web']
}
function resetForm() {
  const parsed = props.task ? parseCron(props.task.cron) : { mode: 'daily' as RepeatMode, time: '09:00', startDate: '' }
  const channels: string[] = props.task
    ? [...new Set<string>((props.task.channels || []).flatMap((channel: string) =>
      channel === 'chat' ? ['web'] : channel === 'im' ? ['feishu', 'qq', 'wechat'] : [channel]))]
    : ['web']
  Object.assign(form, props.task
    ? { name: props.task.name, payload: props.task.payload, time: parsed.time, channels: filterChannels(channels) }
    : blankForm())
  repeatMode.value = parsed.mode
  customStartDate.value = parsed.startDate ?? ''
  intervalMinutes.value = parsed.intervalMinutes ?? 5
  intervalPreset.value = INTERVAL_PRESETS.includes(intervalMinutes.value) ? String(intervalMinutes.value) : 'custom'
  formErr.value = ''
  nextTick(() => { nameRef.value?.focus(); resizePayload() })
}
watch(() => props.show, show => { if (show) resetForm() })
watch(repeatMode, mode => {
  if (mode === 'custom' && !customStartDate.value) customStartDate.value = todayIso()
})
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
function submit() {
  if (!form.name.trim()) { formErr.value = '名称不能为空'; return }
  if (!form.channels.length) { formErr.value = '至少选一个发送渠道'; return }
  formErr.value = ''
  emit('save', {
    name: form.name.trim(), payload: form.payload,
    cron: buildCron({ mode: repeatMode.value, time: form.time, startDate: customStartDate.value, intervalMinutes: intervalMinutes.value }),
    channels: [...form.channels], enabled: props.task ? props.task.enabled : true,
  })
}
</script>

<style scoped>
.sched-modal { padding: 16px 18px; }
.divider { height: 1px; background: linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.07) 20%, rgba(0,0,0,0.07) 80%, transparent 100%); margin: 2px 0 10px; }
.divider-full { margin-left: -18px; margin-right: -18px; background: rgba(0,0,0,0.07); }
.title-input { width: 100%; box-sizing: border-box; outline: none; font-size: 16px; font-weight: 700; color: var(--text-primary); font-family: var(--font-sans); padding: 6px 11px; margin-bottom: 10px; border: 1px solid rgba(0,0,0,0.1); border-radius: var(--radius-sm); background: rgba(255,255,255,0.72); transition: border-color 0.15s, box-shadow 0.15s; }
.title-input::placeholder { color: rgba(0,0,0,0.28); font-weight: 700; }
.title-input:focus { border-color: rgba(123,127,178,0.4); box-shadow: 0 0 0 3px rgba(123,127,178,0.1); }
.field { display: block; margin-bottom: 11px; }
.field > span { display: block; font-size: 12px; font-weight: 700; color: var(--text-secondary); margin-bottom: 6px; }
.field input[type=text], .field input:not([type]), .field textarea, .field select, .field input[type=time], .field input[type=number] { width: 100%; box-sizing: border-box; padding: 8px 11px; border: 1px solid rgba(0,0,0,0.1); border-radius: var(--radius-sm); background: rgba(255,255,255,0.72); font-size: 13px; font-family: var(--font-sans); color: var(--text-primary); outline: none; transition: border-color 0.15s, box-shadow 0.15s; }
.field input:focus, .field textarea:focus, .field select:focus, .field input[type=time]:focus { border-color: rgba(123,127,178,0.4); box-shadow: 0 0 0 3px rgba(123,127,178,0.1); }
.field textarea { min-height: 96px; max-height: 160px; resize: none; line-height: 1.6; overflow-y: hidden; }
.repeat-tabs { display: flex; gap: 6px; }
.repeat-tab { flex: 1; height: 34px; padding: 0; display: flex; align-items: center; justify-content: center; border-radius: var(--radius-sm); border: 1px solid rgba(0,0,0,0.1); background: rgba(255,255,255,0.72); font-size: 13px; font-family: var(--font-sans); color: var(--text-secondary); cursor: pointer; transition: all 0.15s; text-align: center; }
.repeat-tab:hover { border-color: rgba(123,127,178,0.4); }
.repeat-tab.on { background: linear-gradient(135deg,#7b7fb2,#9590c4); color: #fff; border-color: transparent; box-shadow: 0 2px 8px rgba(123,127,178,0.3); }
.date-range { margin-top: 8px; }
.date-range :deep(.dp-input) { height: 34px; box-sizing: border-box; }
.time-field input { height: 34px; padding-top: 8px; padding-bottom: 8px; text-align: center; line-height: normal; font-size: 13px; }
.interval-presets { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 6px; margin-top: 8px; }
.interval-preset { width: 100%; min-width: 0; height: 34px; padding: 0; border-radius: var(--radius-sm); border: 1px solid rgba(0,0,0,0.1); background: rgba(255,255,255,0.72); color: var(--text-secondary); font-size: 12px; font-family: var(--font-sans); cursor: pointer; transition: all 0.15s; }
.interval-preset:hover { border-color: rgba(123,127,178,0.4); }
.interval-preset.on { color: #fff; border-color: transparent; background: linear-gradient(135deg,#7b7fb2,#9590c4); box-shadow: 0 2px 8px rgba(123,127,178,0.25); }
.time-field input[type=number] { appearance: textfield; }
.time-field input[type=number]::-webkit-inner-spin-button, .time-field input[type=number]::-webkit-outer-spin-button { appearance: none; margin: 0; }
.chans { display: flex; gap: 18px; }
.chk-row { display: flex; align-items: center; gap: 7px; cursor: pointer; user-select: none; font-size: 13px; color: var(--text-primary); }
.chk-input { display: none; }
.chk-box { flex-shrink: 0; width: 16px; height: 16px; border-radius: 5px; corner-shape: squircle; border: 1.5px solid rgba(123,127,178,0.35); background: rgba(255,255,255,0.6); display: flex; align-items: center; justify-content: center; transition: background 0.15s, border-color 0.15s, box-shadow 0.15s; }
.chk-input:checked + .chk-box { background: linear-gradient(135deg,#7b7fb2,#9590c4); border-color: transparent; box-shadow: 0 2px 8px rgba(123,127,178,0.35); }
.form-err { color: #d05a5a; font-size: 12px; margin-bottom: 10px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 12px; align-items: center; margin-top: 6px; }
.link { background: none; border: none; cursor: pointer; font-size: 12px; color: var(--text-secondary); padding: 2px 3px; font-family: var(--font-sans); }
.link:hover { color: var(--text-primary); }
.btn-primary { padding: 8px 16px; border: none; border-radius: var(--radius-sm); background: linear-gradient(135deg, #7b7fb2, #9590c4); color: rgba(255,255,255,0.95); font-size: 13px; font-weight: 500; cursor: pointer; font-family: var(--font-sans); display: inline-flex; align-items: center; box-shadow: 0 3px 12px rgba(123,127,178,0.3); transition: transform 0.3s cubic-bezier(0.34,1.2,0.64,1), box-shadow 0.2s ease-out, opacity 0.2s ease-out; }
.btn-primary:hover { opacity: 0.92; }
.btn-primary:disabled { opacity: 0.5; cursor: default; transform: none; }
</style>
