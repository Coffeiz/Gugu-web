<template>
  <div class="task-card" :class="{ off: !task.enabled }">
    <div class="tc-top">
      <span class="tc-name">{{ task.name }}</span>
      <label class="switch sm">
        <input type="checkbox" :checked="task.enabled" @change="$emit('toggle', task)" />
        <span class="slider"></span>
      </label>
    </div>
    <div class="tc-when">{{ cronLabel(task.cron) }} · {{ channelLabel(task.channels) }}</div>
    <div v-if="task.payload" class="tc-payload">{{ task.payload }}</div>
    <div class="tc-foot">
      <span class="tc-last">{{ task.last_run_at ? '上次 ' + fmtTime(task.last_run_at) : '未运行' }}</span>
      <span class="tc-acts">
        <button class="link" :disabled="busy" @click="$emit('run', task)">试运行</button>
        <button class="link" @click="$emit('edit', task)">编辑</button>
        <button class="link danger" @click="$emit('remove', task)">删除</button>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { cronLabel } from '../utils/scheduleCron'

defineProps({
  task: { type: Object, required: true },
  busy: { type: Boolean, default: false },
})

defineEmits<{
  (event: 'toggle' | 'run' | 'edit' | 'remove', task: Record<string, any>): void
}>()

function channelLabel(channels: any) {
  const map = { web: '通知', chat: '通知', feishu: '飞书', qq: 'QQ', wechat: '微信', im: '飞书/QQ/微信' }
  return (channels || []).map((channel: string) => map[channel as keyof typeof map] || channel).join(' + ') || '—'
}

function fmtTime(iso: string) {
  try {
    const date = new Date(iso)
    return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
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
.tc-top { display: flex; align-items: center; gap: 8px; }
.tc-name { font-size: 13px; line-height: 1.2; font-weight: 600; color: var(--text-primary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tc-when { font-size: 12px; color: var(--text-secondary); }
.tc-payload { font-size: 12px; color: var(--text-secondary); background: rgba(0,0,0,0.035); border-radius: 8px; padding: 6px 9px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tc-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 2px; }
.tc-last { font-size: 11px; color: var(--text-secondary); opacity: 0.75; }
.tc-acts { display: flex; gap: 8px; }
.link { background: none; border: none; cursor: pointer; font-size: 12px; color: var(--text-secondary); padding: 2px 3px; font-family: var(--font-sans); }
.link:hover { color: var(--text-primary); }
.link.danger:hover { color: #d05a5a; }
.link:disabled { opacity: 0.5; cursor: default; }
.switch { position: relative; display: inline-block; width: 38px; height: 22px; flex-shrink: 0; }
.switch.sm { width: 32px; height: 19px; }
.switch input { opacity: 0; width: 0; height: 0; }
.slider { position: absolute; inset: 0; background: var(--switch-track-bg); border-radius: 22px; transition: 0.2s; cursor: pointer; }
.slider::before { content: ''; position: absolute; height: 16px; width: 16px; left: 3px; top: 3px; background: var(--switch-thumb-bg); border-radius: 50%; transition: 0.2s; }
.switch.sm .slider::before { height: 13px; width: 13px; }
.switch input:checked + .slider { background: var(--switch-track-bg-active); }
.switch input:checked + .slider::before { transform: translateX(16px); }
.switch.sm input:checked + .slider::before { transform: translateX(13px); }
</style>
