<template>
  <div class="glass-card project-panel">
    <div class="section-header">
      <span class="section-title">当前项目</span>
    </div>

    <div class="project-list">
      <div
        v-for="p in visibleProjects"
        :key="p.id"
        class="project-row"
        @click="openProject(p)"
      >
        <div class="proj-main">
          <!-- 第一行：项目名 -->
          <div class="proj-name" :style="{ color: nameColor(p) }">{{ p.name }}</div>
          <!-- 第二行：客户(左) + 右侧元信息组 -->
          <div class="proj-row2">
            <span class="meta-client" :class="{ empty: !p.client }">
              <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="8" cy="5" r="3"/><path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6"/>
              </svg>
              {{ p.client }}
            </span>
            <div class="meta-right">
              <span class="meta-stage">{{ currentStageLabel(p) }}</span>
              <span class="meta-date" :class="{ urgent: isUrgent(p) }">
                {{ p.deadline ? formatDate(p.deadline) : '' }}<span v-if="isUrgent(p)"> ⚠</span>
              </span>
              <span class="proj-status" :class="'s-' + p.status">
                <i class="status-dot"></i>{{ statusLabel(p.status) }}
              </span>
              <span class="proj-pct" :style="{ color: accentColor(p) }">{{ stageProgress(p) }}%</span>
            </div>
          </div>
          <div class="progress-track">
            <div class="progress-fill" :style="{ width: stageProgress(p) + '%', background: p.color }" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useProjectStore } from '@/stores/projects'

const projectStore = useProjectStore()

function openProject(p) { projectStore.openModal(p) }

const statusLabels = { pending: '待开始', active: '进行中', done: '已完成' }
function statusLabel(s) { return statusLabels[s] ?? s }

const visibleProjects = computed(() => {
  const active  = projectStore.projects.filter(p => p.status === 'active')
  const pending = projectStore.projects
    .filter(p => p.status === 'pending')
    .slice(0, 3)
  const done = projectStore.projects
    .filter(p => p.status === 'done')
    .sort((a, b) => (b.deadline ?? '').localeCompare(a.deadline ?? ''))
    .slice(0, 2)
  return [...active, ...pending, ...done]
})

function currentStageLabel(p) {
  return p.stages.find(s => s.key === p.currentStage)?.label ?? ''
}

function stageProgress(p) {
  if (!p.stages.length) return 0
  const idx = p.stages.findIndex(s => s.key === p.currentStage)
  if (idx < 0) return 0
  return Math.round((idx + 1) / p.stages.length * 100)
}

function darkenHex(hex, amount) {
  const h = hex?.match(/#[0-9a-fA-F]{6}/)?.[0] ?? '#7b7fb2'
  const r = Math.round(parseInt(h.slice(1,3),16) * amount)
  const g = Math.round(parseInt(h.slice(3,5),16) * amount)
  const b = Math.round(parseInt(h.slice(5,7),16) * amount)
  return `rgb(${r},${g},${b})`
}

function accentColor(p) { return darkenHex(p.color, 0.60) }
function nameColor(p)   { return darkenHex(p.color, 0.40) }

function isUrgent(p) {
  if (p.status === 'done' || !p.deadline) return false
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const dl    = new Date(p.deadline + 'T00:00:00')
  return Math.ceil((dl - today) / 86400000) <= 3
}

const thisYear = new Date().getFullYear()
function formatDate(str) {
  const d = new Date(str + 'T00:00:00')
  const base = `${d.getMonth() + 1}月${d.getDate()}日`
  return d.getFullYear() !== thisYear ? `${d.getFullYear()}年${base}` : base
}
</script>

<style scoped>
.project-panel {
  padding: 20px;
  display: flex; flex-direction: column;
}

.project-list {
  display: flex; flex-direction: column;
  gap: 5px;
  padding: 0 4px;
  margin: 0 -4px;
}

.project-row {
  position: relative;
  display: flex; align-items: center;
  padding: 16px 8px;
  cursor: pointer; transition: background 0.25s ease, box-shadow 0.25s ease;
  border-radius: 10px;
}
.project-row + .project-row::before {
  content: '';
  position: absolute;
  top: -3px; left: 8px; right: 8px;
  height: 1px;
  background: rgba(0,0,0,0.1);
}
.project-row:hover { background: rgba(255,255,255,0.65); box-shadow: 0 0 0 1px rgba(255,255,255,0.8), 0 2px 8px rgba(80,90,110,0.05), inset 0 1px 0 rgba(255,255,255,0.6); }

.proj-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }

.proj-name {
  font-size: 14px; font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  padding-bottom: 2px; margin-bottom: -2px;
}

/* 第二行 */
.proj-row2 {
  display: flex; align-items: center;
  font-size: 11px; color: var(--text-secondary);
}
.meta-right {
  display: grid;
  grid-template-columns: 72px 64px 80px 32px;
  align-items: center;
  gap: 0 8px;
  flex-shrink: 0;
  margin-left: auto;
}

.proj-status {
  display: flex; align-items: center; gap: 5px;
  padding: 4px 10px; border-radius: 20px; border: 1.5px solid transparent;
  font-size: 11px; font-weight: 600; white-space: nowrap;
  justify-self: start;
}
.status-dot {
  display: inline-block; width: 6px; height: 6px;
  border-radius: 50%; flex-shrink: 0;
}
.s-pending { background: rgba(212,107,107,0.12); border-color: rgba(212,107,107,0.5); color: #b84a4a; }
.s-active  { background: rgba(201,148,58,0.12);  border-color: rgba(201,148,58,0.5);  color: #a87520; }
.s-done    { background: rgba(90,158,136,0.12);  border-color: rgba(90,158,136,0.4);  color: #3a8870; }
.s-pending .status-dot { background: #d46b6b; }
.s-active  .status-dot { background: #c9943a; }
.s-done    .status-dot { background: #5a9e88; }
.proj-pct  { font-size: 11px; font-weight: 700; text-align: right; }
.meta-client {
  display: flex; align-items: center; gap: 3px;
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.meta-client.empty { opacity: 0.75; }
.meta-stage { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta-date  { white-space: nowrap; }
.meta-date.urgent { color: var(--color-warning); font-weight: 600; }

/* 进度条 */
.progress-track {
  height: 3px; background: rgba(0,0,0,0.07); border-radius: 99px; overflow: hidden;
}
.progress-fill { height: 100%; border-radius: 99px; transition: width 0.4s; }
</style>
