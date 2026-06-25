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
        <!-- 星级优先级（右上角绝对定位） -->
        <div class="row-stars" @click.stop @mousedown.stop>
          <button
            v-for="n in 3" :key="n"
            class="star-btn"
            :style="prioVal(p) >= n ? { color: starColor(p) } : {}"
            :title="PRIO_LABELS[n]"
            @click="setPriority(p, n)"
          >
            <svg width="11" height="11" viewBox="0 0 16 16">
              <polygon
                points="8,1.5 9.8,6 14.5,6.3 11,9.4 12.1,14 8,11.5 3.9,14 5,9.4 1.5,6.3 6.2,6"
                :fill="prioVal(p) >= n ? starColor(p) : 'none'"
              :stroke="prioVal(p) >= n ? starColor(p) : 'currentColor'"
                stroke-width="1.2" stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>

        <div class="proj-main">
          <div class="proj-name" :style="{ color: nameColor(p) }">{{ p.name }}</div>
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
              <span
                class="proj-status" :class="['s-' + p.status, { 'status-advanceable': p.status !== 'done' }]"
                :title="p.status === 'pending' ? '点击移至进行中' : p.status === 'active' ? '点击标记完成' : ''"
                @click.stop="advance(p)"
              >
                <i class="status-dot"></i>{{ statusLabel(p.status) }}
              </span>
              <span class="proj-pct" :style="{ color: accentColor(p) }">{{ stageProgress(p) }}%</span>
            </div>
          </div>
          <div @click.stop @mousedown.stop>
            <SegBar :project="p" />
          </div>
        </div>


      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useProjectStore } from '@/stores/projects'
import SegBar from '@/components/common/SegBar.vue'

const projectStore = useProjectStore()

function openProject(p) { projectStore.openModal(p) }

const statusLabels = { pending: '待开始', active: '进行中', done: '已完成' }
function statusLabel(s) { return statusLabels[s] ?? s }

// ── 排序：进行中 > 待开始 > 已完成，组内按优先级↓→开始日↑→截止日↑→创建日↑ ──
const STATUS_ORDER = { active: 0, pending: 1, done: 2 }
const PRIO_MAP     = { high: 3, medium: 2, low: 1 }
const PRIO_LABELS  = { 1: '低优先级', 2: '中优先级', 3: '高优先级' }
const PRIO_KEYS    = [null, 'low', 'medium', 'high']

function prioVal(p) { return PRIO_MAP[p.priority] ?? 0 }

const visibleProjects = computed(() => {
  const active  = sort(projectStore.projects.filter(p => p.status === 'active'))
  const pending = sort(projectStore.projects.filter(p => p.status === 'pending')).slice(0, 3)
  const done    = sort(projectStore.projects.filter(p => p.status === 'done')).slice(0, 2)
  return [...active, ...pending, ...done]
})

function sort(list) {
  return [...list].sort((a, b) => {
    const pd = prioVal(b) - prioVal(a)
    if (pd !== 0) return pd
    const sd = (a.startDate ?? '').localeCompare(b.startDate ?? '')
    if (sd !== 0) return sd
    const dd = (a.deadline ?? '').localeCompare(b.deadline ?? '')
    if (dd !== 0) return dd
    return (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
  })
}

// ── 优先级 ────────────────────────────────────────────────
function starColor(p) {
  const v = prioVal(p)
  if (v === 3) return '#c45050'
  if (v === 2) return '#c49020'
  return '#8899cc'
}

async function setPriority(p, n) {
  const next = prioVal(p) === n ? null : PRIO_KEYS[n]
  await projectStore.updateProject(p.id, { priority: next })
}

// ── 前进状态（仅前进） ─────────────────────────────────────
const STATUS_NEXT = { pending: 'active', active: 'done' }

async function advance(p) {
  const next = STATUS_NEXT[p.status]
  if (next) await projectStore.moveProject(p.id, next)
}

// ── 辅助 ─────────────────────────────────────────────────
function currentStageLabel(p) {
  return p.stages.find(s => s.key === p.currentStage)?.label ?? ''
}

function stageProgress(p) {
  // 总完成度 = 所有阶段待办里已完成 / 总数（不按阶段位置）；无待办则退回按当前阶段位置
  const stages = p.stages
  if (!stages.length) return 0
  let done = 0, total = 0
  for (const s of stages) {
    const todos = s.todos ?? []
    done += todos.filter(t => t.done).length
    total += todos.length
  }
  if (total > 0) return Math.round(done / total * 100)
  const idx = stages.findIndex(s => s.key === p.currentStage)
  return idx < 0 ? 0 : Math.round((idx + 1) / stages.length * 100)
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
  display: flex; align-items: center; gap: 4px;
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

.proj-row2 {
  display: flex; align-items: center;
  font-size: 11px; color: var(--text-secondary);
}
.meta-right {
  display: grid;
  grid-template-columns: 72px 80px 80px 32px;
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


/* ── 星级（右上角） ── */
.row-stars {
  position: absolute; top: 10px; right: 8px;
  display: flex; align-items: center; gap: 0;
}
.star-btn {
  width: 20px; height: 20px;
  display: flex; align-items: center; justify-content: center;
  background: none; border: none; padding: 0; cursor: pointer;
  color: rgba(0,0,0,0.18);
  transition: transform 0.1s, color 0.1s;
}
.star-btn:hover { transform: scale(1.2); }
.star-btn.active { color: inherit; }

/* 可前进的状态胶囊 */
.status-advanceable { cursor: pointer; transition: background 0.15s, box-shadow 0.15s; }
.status-advanceable:hover { filter: brightness(0.92); box-shadow: 0 2px 8px rgba(0,0,0,0.1), inset 0 0 0 99px rgba(255,255,255,0.2); }
.status-advanceable:active { filter: brightness(0.85); }
</style>
