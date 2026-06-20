<template>
  <div
    class="proj-card"
    draggable="true"
    :style="{ background: `linear-gradient(to right, rgba(255,255,255,0.91), rgba(255,255,255,0.98)), ${project.color}` }"
    @dragstart.stop="$emit('dragstart', $event)"
    @click="$emit('click')"
  >
    <div class="card-body">
      <div class="card-top">
        <div class="proj-name">{{ project.name }}</div>
      </div>
      <div class="proj-meta">
        <span class="proj-client" :class="{ empty: !project.client }">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <circle cx="8" cy="6" r="2.5"/><path d="M2 14c0-3.3 2.7-5 6-5s6 1.7 6 5"/>
          </svg>
          {{ project.client }}
        </span>
        <span class="proj-stage">{{ currentStageLabel }}</span>
      </div>

      <div class="card-footer">
        <div class="date-range">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <rect x="1.5" y="2.5" width="13" height="12" rx="2"/>
            <path d="M5 1v3M11 1v3M1.5 6.5h13"/>
          </svg>
          <span v-if="project.startDate" class="date-start">{{ fmtDate(project.startDate) }}</span>
          <span v-if="project.startDate && project.deadline" class="date-sep">→</span>
          <span class="deadline" :class="{ urgent: isUrgent }">{{ deadlineLabel }}</span>
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

      <div class="progress-bar">
        <div class="progress-fill" :style="{ width: stageProgress + '%', background: project.color }"></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({ project: { type: Object, required: true } })
defineEmits(['click', 'dragstart'])


const currentStageIndex = computed(() =>
  props.project.stages.findIndex(s => s.key === props.project.currentStage)
)
const currentStageLabel = computed(() =>
  props.project.stages[currentStageIndex.value]?.label ?? ''
)
const stageProgress = computed(() => {
  const stages = props.project.stages
  if (!stages.length) return 0
  const idx = currentStageIndex.value
  if (idx < 0) return 0
  return Math.round((idx + 1) / stages.length * 100)
})

const daysLeft      = computed(() => {
  if (!props.project.deadline) return null
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const dl    = new Date(props.project.deadline + 'T00:00:00')
  return Math.ceil((dl - today) / 86400000)
})
const isUrgent      = computed(() => props.project.status !== 'done' && daysLeft.value <= 3)
const thisYear = new Date().getFullYear()
function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso + 'T00:00:00')
  const mm = `${d.getMonth()+1}/${d.getDate()}`
  return d.getFullYear() !== thisYear ? `${d.getFullYear()}/${mm}` : mm
}
const deadlineLabel = computed(() => {
  if (!props.project.deadline) return '—'
  const d = daysLeft.value
  if (d < 0) {
    if (props.project.status !== 'done') return `逾期 ${-d} 天`
    return fmtDate(props.project.deadline)
  }
  if (d === 0) return '今天截止'
  if (d === 1) return '明天'
  if (d <= 7)  return `${d}天后`
  return fmtDate(props.project.deadline)
})
</script>

<style scoped>
.proj-card {
  position: relative; display: flex; flex-shrink: 0;
  border: 1px solid rgba(255,255,255,0.72);
  border-radius: var(--radius-md);
  corner-shape: squircle;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 2px 8px rgba(80,90,110,0.07);
  overflow: hidden; cursor: pointer;
  transition: transform 0.3s cubic-bezier(0.34,1.2,0.64,1),
              box-shadow 0.3s ease, background 0.25s ease-out;
  user-select: none;
}
.proj-card:hover {
  transform: translateY(-2px);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 6px 18px rgba(80,90,110,0.13);
}
.proj-card:active { transform: translateY(1px); opacity: 0.93; }


.card-body { flex: 1; padding: 13px 13px 11px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.card-top { display: flex; align-items: flex-start; gap: 6px; }

.proj-name {
  font-size: 13px; font-weight: 600; color: var(--text-primary);
  line-height: 1.35; flex: 1; overflow: hidden;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.proj-meta {
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
}
.proj-client {
  display: flex; align-items: center; gap: 4px;
  font-size: 11px; color: var(--text-secondary);
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis; flex: 1;
  padding-bottom: 2px; margin-bottom: -2px;
}
.proj-client svg { flex-shrink: 0; opacity: 0.85; }
.proj-client.empty { opacity: 0.75; }
.proj-stage {
  font-size: 10px; color: var(--text-secondary);
  opacity: 0.6; white-space: nowrap; flex-shrink: 0;
}

.card-footer { display: flex; align-items: center; justify-content: space-between; }
.footer-right { display: flex; align-items: center; gap: 6px; }

.date-range {
  display: flex; align-items: center; gap: 4px;
  font-size: 11px; color: var(--text-secondary); min-width: 0; overflow: hidden;
}
.date-range svg { flex-shrink: 0; }
.date-start { opacity: 0.65; white-space: nowrap; }
.date-sep { opacity: 0.35; font-size: 9px; }
.deadline { white-space: nowrap; }
.deadline.urgent { color: var(--color-warning); font-weight: 600; }

.file-badge {
  display: flex; align-items: center; gap: 3px;
  font-size: 10px; font-weight: 600; color: var(--text-secondary);
  background: rgba(0,0,0,0.06); border-radius: 10px; padding: 1px 6px;
}
.progress-num { font-size: 10px; color: var(--text-secondary); }
.progress-bar { height: 4px; background: rgba(0,0,0,0.07); border-radius: 99px; overflow: hidden; }
.progress-fill { height: 100%; border-radius: 99px; transition: width 0.3s; }
</style>
