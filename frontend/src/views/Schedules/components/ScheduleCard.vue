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
        <button class="link" :disabled="props.busy || isEnded()" @click="$emit('run', props.task)">{{ t('schedules.testRun') }}</button>
        <button class="link" @click="$emit('edit', props.task)">{{ t('schedules.edit') }}</button>
        <button class="link danger" @click="$emit('remove', props.task)">{{ t('schedules.delete') }}</button>
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
  background: rgba(255,255,255,0.56); border: 1px solid rgba(255,255,255,0.72);
  border-radius: var(--radius-md);
  box-shadow: 0 2px 8px rgba(80,90,110,0.07);
  padding: 13px 15px; display: flex; flex-direction: column; gap: 7px;
  height: 100%; min-height: 154px; box-sizing: border-box;
  overflow: hidden;
  transition: transform 0.3s cubic-bezier(0.34,1.2,0.64,1), box-shadow 0.3s ease, background 0.25s ease-out;
}
.task-card::after {
  content: ''; position: absolute; inset: 0; border-radius: inherit;
  background: linear-gradient(to top, rgba(255,255,255,0.08), transparent 50%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9);
  transition: background 0.3s cubic-bezier(0.34,1.2,0.64,1); pointer-events: none;
}
.task-card > * { position: relative; z-index: 1; }
.task-card:hover { box-shadow: 0 6px 18px rgba(80,90,110,0.13); }
.task-card:hover::after { background: rgba(255,255,255,0.2); }
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
.link { background: none; border: none; cursor: pointer; font-size: 12px; color: var(--text-secondary); padding: 2px 3px; font-family: var(--font-sans); }
.link:hover { color: var(--text-primary); }
.link.danger:hover { color: #d05a5a; }
.link:disabled { opacity: 0.5; cursor: default; }
</style>
