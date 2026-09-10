<template>
  <div class="task-card" :class="{ off: !props.task.enabled }">
    <div class="tc-top">
      <span class="tc-name" :title="props.task.name">{{ props.task.name }}</span>
      <ToggleSwitch size="sm" :model-value="props.task.enabled" :aria-label="props.task.enabled ? t('schedules.disable') : t('schedules.enable')" @update:model-value="$emit('toggle', props.task)" />
    </div>
    <div class="tc-when">{{ scheduleLabel() }} · {{ channelLabel(props.task.channels) }}</div>
    <div class="tc-window">
      <span>{{ t('schedules.startAt') }} {{ props.task.start_at ? fmtDateTime(props.task.start_at) : t('schedules.noStart') }}</span>
      <span>{{ t('schedules.endAt') }} {{ props.task.end_at ? fmtDateTime(props.task.end_at) : t('schedules.noEnd') }}</span>
    </div>
    <span v-if="isEnded()" class="tc-status ended">{{ t('schedules.ended') }}</span>
    <div v-if="props.task.payload" class="tc-payload" :title="props.task.payload">{{ props.task.payload }}</div>
    <div class="tc-foot">
      <span class="tc-last">{{ props.task.last_run_at ? t('schedules.previousRun', { time: fmtTime(props.task.last_run_at) }) : t('schedules.neverRun') }}</span>
      <span class="tc-acts">
        <button class="card-link-btn" :disabled="props.busy || isEnded()" @click="$emit('run', props.task)">{{ t('schedules.testRun') }}</button>
        <button class="card-link-btn" @click="$emit('edit', props.task)">{{ t('schedules.edit') }}</button>
        <button class="card-link-btn danger" @click="$emit('remove', props.task)">{{ t('schedules.delete') }}</button>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { cronLabel } from '../utils/scheduleCron'
import ToggleSwitch from '@/components/common/controls/ToggleSwitch.vue'
import { useI18n } from 'vue-i18n'
import { effectiveTimezone } from '@/utils/userTimezone'

const props = defineProps({
  task: { type: Object, required: true },
  busy: { type: Boolean, default: false },
})

defineEmits<{
  (event: 'toggle' | 'run' | 'edit' | 'remove', task: Record<string, any>): void
}>()
const { t, locale } = useI18n()

function channelLabel(channels: any) {
  const map = { web: t('schedules.webNotice'), email: t('schedules.email'), chat: t('schedules.webNotice'), feishu: t('schedules.feishu'), qq: t('schedules.qq'), wechat: t('schedules.wechat'), im: `${t('schedules.feishu')}/${t('schedules.qq')}/${t('schedules.wechat')}` }
  return (channels || []).map((channel: string) => map[channel as keyof typeof map] || channel).join(' + ') || '—'
}

function scheduleLabel() {
  if (props.task.schedule_kind === 'interval') {
    return t('schedules.everyMinutes', { minutes: props.task.interval_minutes ?? '—' })
  }
  if (props.task.schedule_kind === 'once') return t('schedules.once')
  return cronLabel(props.task.cron)
}

function isEnded() {
  if (props.task.schedule_status === 'ended') return true
  if (!props.task.end_at) return false
  const timestamp = new Date(props.task.end_at).getTime()
  return Number.isFinite(timestamp) && timestamp < Date.now()
}

function fmtTime(iso: string) {
  try {
    const date = new Date(iso)
    return new Intl.DateTimeFormat(locale.value, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: effectiveTimezone() }).format(date)
  } catch {
    return ''
  }
}

function fmtDateTime(iso: string) {
  try {
    return new Intl.DateTimeFormat(locale.value, {
      year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
      hour12: false, timeZone: effectiveTimezone(),
    }).format(new Date(iso))
  } catch {
    return ''
  }
}
</script>

<style scoped>
.task-card {
  position: relative;
  background: var(--surface-card); border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--card-shadow);
  padding: 13px 15px; display: flex; flex-direction: column; gap: 7px;
  height: 100%; min-height: 154px; box-sizing: border-box;
  overflow: hidden;
  transition: var(--card-motion), box-shadow var(--motion-hover-card) ease, opacity var(--hover-motion-control);
}
.task-card::after {
  content: ''; position: absolute; inset: 0; border-radius: inherit;
  background: var(--card-hover-overlay);
  box-shadow: none;
  opacity: 0; transition: var(--card-overlay-motion); pointer-events: none;
}
.task-card > * { position: relative; z-index: 1; }
.task-card:hover { box-shadow: var(--card-shadow-hover); }
.task-card:hover::after { opacity: 1; }
.task-card.off { opacity: 0.5; }
.tc-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.tc-name { min-width: 0; font-size: 13px; line-height: 19px; font-weight: 600; color: var(--text-primary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tc-when { font-size: 12px; color: var(--text-secondary); }
.tc-window { display: grid; gap: 2px; min-height: 31px; font-size: 11px; color: var(--text-secondary); line-height: 1.4; }
.tc-window span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tc-status { align-self: flex-start; padding: 2px 7px; border-radius: 999px; font-size: 11px; }
.tc-status.ended { color: var(--status-danger); background: color-mix(in srgb, var(--status-danger) 10%, transparent); }
.tc-payload { font-size: 12px; color: var(--text-secondary); background: rgba(0,0,0,0.035); border-radius: 8px; padding: 6px 9px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tc-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: auto; }
.tc-last { font-size: 11px; color: var(--text-secondary); opacity: 0.75; }
.tc-acts { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
</style>
