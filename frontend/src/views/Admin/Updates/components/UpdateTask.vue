<template>
  <section class="update-card">
    <header class="section-head">
      <div>
        <h3>{{ t('adminUpdateUi.task') }}</h3>
        <p v-if="task">{{ task.version }} · {{ statusLabel(task.status) }}</p>
        <p v-else>{{ t('adminUpdateUi.notChecked') }}</p>
      </div>
      <button class="btn-ghost" :disabled="loading" @click="$emit('refresh')">{{ t('adminUpdateUi.refresh') }}</button>
    </header>

    <template v-if="task">
      <div class="task-status" :class="task.status">
        <span class="status-dot" />
        <strong>{{ statusLabel(task.status) }}</strong>
        <span class="task-message">{{ task.failure_code || task.message }}</span>
      </div>
      <div class="progress-line" role="progressbar" :aria-valuenow="task.progress" aria-valuemin="0" aria-valuemax="100">
        <span :style="{ width: `${Math.max(0, Math.min(100, task.progress || 0))}%` }" />
      </div>
      <div class="task-meta">
        <span>{{ t('adminUpdateUi.progress') }} <b>{{ task.progress || 0 }}%</b></span>
        <span v-if="task.requested_by">{{ t('adminUpdateUi.requestedBy') }} <b>{{ task.requested_by }}</b></span>
        <span v-if="task.created_at">{{ t('adminUpdateUi.startedAt') }} <b>{{ formatTime(task.created_at) }}</b></span>
      </div>
      <p v-if="task.status === 'rollback_required' && task.rollback_supported" class="rollback-hint">{{ t('adminUpdateUi.rollbackAvailable') }}</p>
      <button
        v-if="task.status === 'rollback_required' && task.rollback_supported"
        class="btn-danger"
        :disabled="!!action"
        @click="$emit('rollback')"
      >{{ action === 'rollback' ? t('adminUpdateUi.rollingBack') : t('adminUpdateUi.rollback') }}</button>
    </template>

    <div v-if="history.length" class="history">
      <h4>{{ t('adminUpdateUi.history') }}</h4>
      <div v-for="row in history.slice(0, 5)" :key="row.id" class="history-row">
        <span>{{ row.version }}</span>
        <span class="history-status">{{ statusLabel(row.status) }}</span>
        <time v-if="row.completed_at || row.updated_at">{{ formatTime(row.completed_at || row.updated_at || '') }}</time>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { UpdateTask as UpdateTaskData } from '@/services/adminUpdate'

defineProps<{
  task: UpdateTaskData | null
  history: UpdateTaskData[]
  loading: boolean
  action: string
}>()
defineEmits<{ refresh: []; rollback: [] }>()
const { t, locale } = useI18n()

function statusLabel(status: string) {
  const path = `adminUpdateUi.statuses.${status}`
  const result = t(path)
  return result === path ? status : result
}

function formatTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
</script>

<style scoped>
.update-card { padding: 22px 24px; border: 1px solid var(--panel-glass-border); border-radius: var(--radius-lg); background: var(--panel-glass-bg); color: var(--content-primary); box-shadow: var(--elevation-card); }
.section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.section-head h3 { margin: 0; font-size: 14px; }
.section-head p { margin: 5px 0 0; color: var(--content-tertiary); font-size: 12px; }
.btn-ghost, .btn-danger { min-height: 30px; padding: 5px 12px; border-radius: var(--radius-sm); font-size: 12px; cursor: pointer; }
.btn-ghost { border: 1px solid var(--border-subtle); background: var(--surface-glass); color: var(--content-secondary); }
.btn-danger { border: 1px solid color-mix(in srgb, var(--status-danger) 45%, transparent); background: color-mix(in srgb, var(--status-danger) 15%, transparent); color: var(--status-danger); }
.btn-ghost:disabled, .btn-danger:disabled { cursor: default; opacity: .5; }
.task-status { display: flex; align-items: center; gap: 9px; min-width: 0; font-size: 12px; }
.status-dot { width: 8px; height: 8px; flex: 0 0 8px; border-radius: 50%; background: var(--action-primary); }
.task-status.succeeded .status-dot { background: var(--status-success); }
.task-status.failed .status-dot, .task-status.rollback_required .status-dot { background: var(--status-danger); }
.task-message { overflow: hidden; margin-left: auto; color: var(--content-tertiary); text-overflow: ellipsis; white-space: nowrap; }
.progress-line { height: 7px; overflow: hidden; margin: 14px 0 10px; border-radius: 8px; background: var(--surface-glass); }
.progress-line span { display: block; height: 100%; border-radius: inherit; background: var(--action-primary-bg); transition: width .25s ease; }
.task-meta { display: flex; flex-wrap: wrap; gap: 8px 20px; color: var(--content-tertiary); font-size: 11px; }
.task-meta b { margin-left: 5px; color: var(--content-secondary); font-weight: 500; }
.rollback-hint { margin: 14px 0 8px; color: var(--status-warning); font-size: 12px; line-height: 1.5; }
.history { margin-top: 22px; padding-top: 15px; border-top: 1px solid var(--panel-divider); }
.history h4 { margin: 0 0 10px; font-size: 12px; }
.history-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--panel-divider); color: var(--content-secondary); font-size: 11px; }
.history-row:last-child { border-bottom: 0; }
.history-status { color: var(--content-tertiary); }
.history-row time { color: var(--content-tertiary); text-align: right; }
</style>
