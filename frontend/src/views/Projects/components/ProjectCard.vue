<template>
  <div
    class="proj-card"
    draggable="true"
    :style="{ background: `linear-gradient(to right, rgba(255,255,255,0.9) 0%, rgba(255,255,255,1) 40%), ${project.color}` }"
    @dragstart.stop="$emit('dragstart', $event)"
    @click="$emit('click')"
  >
    <div class="card-body">
      <div class="card-top">
        <div class="proj-name" :style="{ color: nameColor }">{{ project.name }}</div>
        <!-- 星级优先级 -->
        <div class="stars" @click.stop @mousedown.stop>
          <button
            v-for="n in 3"
            :key="n"
            class="star-btn"
            :class="{ active: prioValue >= n }"
            :title="PRIO_LABELS[n]"
            @click="setPriority(n)"
          >
            <svg width="11" height="11" viewBox="0 0 16 16">
              <polygon
                points="8,1.5 9.8,6 14.5,6.3 11,9.4 12.1,14 8,11.5 3.9,14 5,9.4 1.5,6.3 6.2,6"
                :fill="prioValue >= n ? starColor : 'none'"
                :stroke="prioValue >= n ? starColor : 'currentColor'"
                stroke-width="1.2"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>
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
          <template v-if="project.status === 'done'">
            <span class="done-label"><PhCheck :size="9" weight="bold" /> 完成</span>
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

      <div v-if="project.stages.length" class="seg-bar" @click.stop @mousedown.stop>
        <div
          v-for="(stage, i) in project.stages"
          :key="stage.key"
          class="seg"
          :title="stage.label"
          @click.stop="clickStage(i)"
        >
          <div class="seg-fill" :style="segFillStyle(i)"></div>
        </div>
      </div>
      <div v-else class="progress-bar">
        <div class="progress-fill" :style="{ width: stageProgress + '%', background: project.color }"></div>
      </div>
    </div>

    <!-- 推进到下一阶段按钮，已完成不显示 -->
    <button
      v-if="project.status !== 'done'"
      class="card-advance"
      :title="advanceLabel"
      @click.stop="advance"
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </button>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useProjectStore } from '@/stores/projects'
import { PhCheck } from '@phosphor-icons/vue'

const props = defineProps({ project: { type: Object, required: true } })
defineEmits(['click', 'dragstart'])

const projectStore = useProjectStore()

const nameColor = computed(() => {
  const hex = props.project.color?.match(/#[0-9a-fA-F]{6}/)?.[0] ?? '#7b7fb2'
  const r = Math.round(parseInt(hex.slice(1,3),16) * 0.40)
  const g = Math.round(parseInt(hex.slice(3,5),16) * 0.40)
  const b = Math.round(parseInt(hex.slice(5,7),16) * 0.40)
  return `rgb(${r},${g},${b})`
})

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
  const w = 100 / stages.length
  const todos = stages[idx].todos ?? []
  const within = todos.length > 0 ? (todos.filter(t => t.done).length / todos.length) * w : w
  return Math.round(idx * w + within)
})

const daysLeft  = computed(() => {
  if (!props.project.deadline) return null
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const dl    = new Date(props.project.deadline + 'T00:00:00')
  return Math.ceil((dl - today) / 86400000)
})
const isUrgent = computed(() => props.project.status !== 'done' && daysLeft.value <= 3)
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

// ── 推进状态列 ────────────────────────────────────────────
const STATUS_NEXT  = { pending: 'active', active: 'done' }
const STATUS_LABEL = { pending: '移至进行中', active: '标记完成' }
const advanceLabel = computed(() => STATUS_LABEL[props.project.status] ?? '')

async function advance() {
  const next = STATUS_NEXT[props.project.status]
  if (next) await projectStore.moveProject(props.project.id, next)
}

// ── 星级优先级 ────────────────────────────────────────────
// 1=低, 2=中, 3=高；null=无
const PRIO_MAP    = { low: 1, medium: 2, high: 3 }
const PRIO_LABELS = { 1: '低优先级', 2: '中优先级', 3: '高优先级' }
const PRIO_KEYS   = [null, 'low', 'medium', 'high']

const prioValue = computed(() => PRIO_MAP[props.project.priority] ?? 0)

const starColor = computed(() => {
  if (prioValue.value === 3) return '#c45050'
  if (prioValue.value === 2) return '#c49020'
  return '#8899cc'
})

function segFillStyle(i) {
  const n = props.project.stages.length
  const w = segFill(i)
  const pos = n <= 1 ? '0%' : `${(i / (n - 1)) * 100}%`
  return { width: w + '%', background: props.project.color, backgroundSize: `${n * 100}% 100%`, backgroundPosition: `${pos} 0%` }
}

function segFill(i) {
  const idx = currentStageIndex.value
  if (i < idx) return 100
  if (i > idx) return 0
  const todos = props.project.stages[i].todos ?? []
  if (!todos.length) return 100
  return Math.round(todos.filter(t => t.done).length / todos.length * 100)
}

async function clickStage(i) {
  const stages = props.project.stages
  const stage = stages[i]
  const n = stages.length
  const w = 100 / n
  const todos = stage.todos ?? []
  const within = todos.length > 0 ? (todos.filter(t => t.done).length / todos.length) * w : w
  const progress = Math.round(i * w + within)
  await projectStore.setStage(props.project.id, stage.key, progress)
}

async function setPriority(n) {
  // 再次点击同一级别则取消
  const next = prioValue.value === n ? null : PRIO_KEYS[n]
  await projectStore.updateProject(props.project.id, { priority: next })
}
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
.proj-card::after {
  content: '';
  position: absolute; inset: 0;
  border-radius: inherit;
  background: linear-gradient(to top, rgba(255,255,255,0.25), rgba(255,255,255,0.05));
  opacity: 0;
  transition: opacity 0.3s cubic-bezier(0.34,1.2,0.64,1);
  pointer-events: none;
}
.proj-card:hover {
  transform: translateY(-2px);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 6px 18px rgba(80,90,110,0.13);
}
.proj-card:hover::after { opacity: 1; }
.proj-card:active:not(:has(.stars:active, .seg-bar:active)) { transform: translateY(1px); opacity: 0.93; }

.card-body { flex: 1; padding: 13px 13px 11px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.card-top { display: flex; align-items: flex-start; gap: 6px; }

.proj-name {
  font-size: 13px; font-weight: 500; color: var(--text-primary);
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
.footer-right { display: flex; align-items: center; gap: 5px; }

.date-range {
  display: flex; align-items: center; gap: 4px;
  font-size: 11px; color: var(--text-secondary); min-width: 0; overflow: hidden;
}
.date-range svg { flex-shrink: 0; }
.date-start { opacity: 0.65; white-space: nowrap; }
.date-sep { opacity: 0.35; font-size: 9px; }
.deadline { white-space: nowrap; }
.done-label { white-space: nowrap; font-size: 10px; font-weight: 700; color: #3a8870; background: rgba(90,158,136,0.12); border: 1px solid rgba(90,158,136,0.35); border-radius: 20px; padding: 1px 6px; }
.deadline.urgent { color: var(--color-warning); font-weight: 600; }

.file-badge {
  display: flex; align-items: center; gap: 3px;
  font-size: 10px; font-weight: 600; color: var(--text-secondary);
  background: rgba(0,0,0,0.06); border-radius: 10px; padding: 1px 6px;
}
.progress-num { font-size: 10px; color: var(--text-secondary); }
.progress-bar { height: 4px; background: rgba(0,0,0,0.07); border-radius: 99px; overflow: hidden; }
.progress-fill { height: 100%; border-radius: 99px; transition: width 0.3s; }

.seg-bar { display: flex; gap: 2px; height: 5px; }
.seg {
  flex: 1; height: 100%; border-radius: 99px;
  background: rgba(0,0,0,0.07); overflow: hidden; cursor: pointer;
  transition: transform 0.18s ease, opacity 0.15s;
  transform-origin: center; position: relative;
}
.seg::before {
  content: ''; position: absolute; inset: -6px 0;
}
.seg:hover { transform: scaleY(1.7); opacity: 0.8; }
.seg-fill { height: 100%; border-radius: 99px; transition: width 0.3s; }

/* ── 星级 ── */
.stars { display: flex; align-items: center; gap: 0; }
.star-btn {
  width: 18px; height: 18px;
  display: flex; align-items: center; justify-content: center;
  background: none; border: none; padding: 0; cursor: pointer;
  color: rgba(0,0,0,0.2);
  transition: transform 0.1s, color 0.1s;
}
.star-btn:hover { transform: scale(1.2); }
.star-btn.active { color: v-bind(starColor); }

/* ── 推进按钮（圆角靠父级 overflow:hidden 裁剪）── */
.card-advance {
  width: 42px; flex-shrink: 0; align-self: stretch;
  display: flex; align-items: center; justify-content: center;
  background: none; border: none;
  border-left: 1px solid rgba(0,0,0,0.07);
  cursor: pointer;
  color: rgba(0,0,0,0.25);
  transition: background 0.15s, color 0.15s;
}
.card-advance:hover {
  background: rgba(0,0,0,0.05);
  color: var(--text-primary);
}
.card-advance:active { background: rgba(0,0,0,0.1); }
</style>
