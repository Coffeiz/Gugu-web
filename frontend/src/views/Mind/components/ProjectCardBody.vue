<template>
  <div class="card-body project-card-body">
    <div class="proj-name" :style="{ color: nameColor }">{{ project.name }}</div>
    <div class="proj-meta">
      <span class="proj-client" :class="{ empty: !project.client }">
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <circle cx="8" cy="6" r="2.5"/><path d="M2 14c0-3.3 2.7-5 6-5s6 1.7 6 5"/>
        </svg>
        {{ project.client }}
      </span>
      <span class="proj-stage" :title="currentStageLabel">
        <span class="ps-label">{{ currentStageLabel || t('mindUi.stage') }}</span>
        <span v-if="curTodoTotal" class="ps-count">{{ curDoneCount }}/{{ curTodoTotal }}</span>
      </span>
    </div>
    <div class="card-footer">
      <div class="date-range">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <rect x="1.5" y="2.5" width="13" height="12" rx="2"/>
          <path d="M5 1v3M11 1v3M1.5 6.5h13"/>
        </svg>
        <template v-if="project.status === 'done'">
          <span class="done-label"><PhCheck :size="9" weight="bold" /> {{ t('mindUi.completed') }}</span>
          <span v-if="project.doneAt" class="deadline">{{ fmtDate(project.doneAt.slice(0, 10)) }}</span>
        </template>
        <template v-else>
          <span v-if="project.startDate" class="date-start">{{ fmtDate(project.startDate) }}</span>
          <span v-if="project.startDate && project.deadline" class="date-sep">→</span>
          <span class="deadline" :class="{ urgent: isUrgent }">{{ deadlineLabel }}</span>
        </template>
      </div>
      <div class="footer-right">
        <span v-if="project.fileCount" class="file-badge">
          <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 1.5h5l2.5 2.5V10a.5.5 0 01-.5.5h-7A.5.5 0 011.5 10V2a.5.5 0 01.5-.5z"/>
            <path d="M7 1.5V4H9.5"/>
          </svg>
          {{ project.fileCount }}
        </span>
        <span class="progress-num">{{ stageProgress }}%</span>
      </div>
    </div>
    <div class="seg-bar-wrap"><SegBar :project="project" /></div>
  </div>
</template>

<script setup lang="ts">
import { computed, type PropType } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhCheck } from '@phosphor-icons/vue'
import SegBar from '@/components/common/controls/SegBar.vue'
import { useProjectCardBasics } from '@/composables/useProjectCardBasics'
import type { Project } from '@/types/project'
import './project-card-visual.css'

const props = defineProps({
  project: { type: Object as PropType<Project>, required: true },
})
const { t } = useI18n()

const projectRef = computed(() => props.project)
const { currentStageLabel, curTodoTotal, curDoneCount, stageProgress, nameColor, isUrgent, fmtDate, deadlineLabel } = useProjectCardBasics(projectRef)
</script>

<style scoped>
.card-body { padding: 13px 13px 11px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.proj-name { font-size: 13px; font-weight: 500; color: var(--text-primary); line-height: 1.35; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.proj-meta { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.proj-client { display: flex; align-items: center; gap: 4px; font-size: 11px; line-height: 1.15; color: var(--text-secondary); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; flex: 1; }
.proj-client svg { opacity: 0.85; }
.proj-client.empty { opacity: 0.75; }
.proj-stage { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; line-height: 1.15; color: var(--text-secondary); white-space: nowrap; flex-shrink: 0; opacity: 0.75; }
.ps-label { overflow: hidden; text-overflow: ellipsis; max-width: 130px; }
.ps-count { font-size: 9px; line-height: 1.15; opacity: 0.8; font-variant-numeric: tabular-nums; }
.card-footer { display: flex; align-items: center; justify-content: space-between; }
.date-range { display: flex; align-items: center; gap: 4px; font-size: 11px; line-height: 1.15; color: var(--text-secondary); min-width: 0; overflow: hidden; }
.date-start { opacity: 0.65; white-space: nowrap; }
.date-sep { opacity: 0.35; font-size: 9px; }
.deadline { white-space: nowrap; }
.deadline.urgent { color: var(--color-warning); font-weight: 600; }
.done-label { white-space: nowrap; font-size: 10px; font-weight: 700; color: #3a8870; background: rgba(90,158,136,0.12); box-shadow: inset 0 0 0 1px rgba(90,158,136,0.35); border-radius: 20px; padding: 0 6px; display: inline-flex; align-items: center; gap: 2px; line-height: 1.15; }
.footer-right { display: flex; align-items: center; gap: 5px; line-height: 1.15; }
.file-badge { display: flex; align-items: center; gap: 3px; font-size: 10px; line-height: 1.15; font-weight: 600; color: var(--text-secondary); background: rgba(0,0,0,0.06); border-radius: 10px; padding: 1px 6px; }
.proj-client > svg, .date-range > svg, .done-label > svg, .file-badge > svg { display: block; flex: 0 0 auto; transform: translateY(-0.35px); }
.progress-num { font-size: 10px; line-height: 1.15; color: var(--text-secondary); }
.seg-bar-wrap { position: relative; }
</style>
