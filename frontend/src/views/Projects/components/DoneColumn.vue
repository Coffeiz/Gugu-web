<template>
  <div
    class="done-col"
    data-col-status="done"
    :class="{ 'drag-over': isDragOver }"
    @dragover.prevent="isDragOver = true"
    @dragleave="isDragOver = false"
    @drop.prevent="onDrop"
  >
    <div class="col-header">
      <div class="col-title">
        <span class="col-dot"></span>
        已完成
      </div>
      <div class="col-header-right">
        <button class="archived-entry-mini" @click="$emit('open-archived')" title="查看已归档项目">
          <PhArchive :size="11" weight="bold" />
          已归档
        </button>
        <span class="col-count">{{ projects.length }}</span>
      </div>
    </div>

    <div class="col-body">
      <div v-if="projects.length === 0" class="col-empty">拖拽项目到此</div>

      <template v-else>
        <!-- 最近完成（置顶 3 个，直接可见，无需展开文件夹）-->
        <div v-if="recentDone.length" class="recent-done">
          <div class="recent-done-label">
            <PhCheckCircle :size="12" weight="fill" style="color:#5a9e88" />
            最近完成
          </div>
          <div class="month-cards">
            <ProjectCard
              v-for="p in recentDone"
              :key="'recent-' + p.id"
              :project="p"
              @click="$emit('card-click', p)"
            />
          </div>
        </div>

        <!-- 年目录 -->
        <div v-for="yg in groupedByYear" :key="yg.year" class="year-group">
          <button class="year-row" @click="toggleYear(yg.year)">
            <svg
              class="year-chev" :class="{ open: openYears.has(yg.year) }"
              width="9" height="9" viewBox="0 0 10 10" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round"
            >
              <path d="M2 3.5l3 3 3-3"/>
            </svg>
            <span class="year-label">{{ yg.year }}</span>
            <span class="year-cnt">{{ yg.total }}</span>
          </button>

          <!-- v-if（非 v-show）：折叠的年份完全不渲染其下卡片，避免已完成项目累积后全量挂载拖慢初次渲染 -->
          <div v-if="openYears.has(yg.year)" class="year-body">
            <!-- 月目录 -->
            <div v-for="mg in yg.months" :key="mg.month" class="month-group">
              <button class="month-row" @click="toggleMonth(yg.year + mg.month)">
                <PhFolderOpen v-if="openMonths.has(yg.year + mg.month)" :size="13" weight="fill" style="color:#5a9e88; opacity:0.85; flex-shrink:0" />
                <PhFolder v-else :size="13" weight="regular" style="flex-shrink:0; opacity:0.6" />
                <span class="month-name">{{ mg.month }}</span>
                <span class="month-cnt">{{ mg.items.length }}</span>
                <svg
                  class="month-chev" :class="{ open: openMonths.has(yg.year + mg.month) }"
                  width="8" height="8" viewBox="0 0 10 10" fill="none"
                  stroke="currentColor" stroke-width="2" stroke-linecap="round"
                >
                  <path d="M2 3.5l3 3 3-3"/>
                </svg>
              </button>

              <div v-if="openMonths.has(yg.year + mg.month)" class="month-cards">
                <ProjectCard
                  v-for="p in mg.items"
                  :key="p.id"
                  :project="p"
                  @click="$emit('card-click', p)"
                />
              </div>
            </div>
          </div>
        </div>

        <!-- 未设置日期 -->
        <div v-if="undatedProjects.length" class="year-group">
          <button class="year-row" @click="toggleYear('__undated')">
            <svg
              class="year-chev" :class="{ open: openYears.has('__undated') }"
              width="9" height="9" viewBox="0 0 10 10" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round"
            >
              <path d="M2 3.5l3 3 3-3"/>
            </svg>
            <span class="year-label undated">未设置日期</span>
            <span class="year-cnt">{{ undatedProjects.length }}</span>
          </button>
          <div v-if="openYears.has('__undated')" class="year-body">
            <div class="month-cards" style="padding-left: 8px">
              <ProjectCard
                v-for="p in undatedProjects"
                :key="p.id"
                :project="p"
                @click="$emit('card-click', p)"
              />
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, type PropType } from 'vue'
import ProjectCard from './ProjectCard.vue'
import { PhFolder, PhFolderOpen, PhCheckCircle, PhArchive } from '@phosphor-icons/vue'

const props = defineProps({
  projects: { type: Array as PropType<any[]>, default: () => [] },
})
const emit = defineEmits(['card-click', 'drop-project', 'open-archived'])

const isDragOver  = ref(false)
const openYears   = ref(new Set())
const openMonths  = ref(new Set())

function dateOf(p) {
  const src = p.startDate || p.deadline || p.doneAt || null
  if (!src) return null
  return new Date(src.length === 10 ? src + 'T00:00:00' : src)
}

// 最近完成：按完成时间倒序取前 3，置顶直接可见（不进下面的年/月文件夹，避免重复）
const recentDone = computed(() =>
  [...props.projects]
    .sort((a, b) => {
      const ta = a.doneAt || a.deadline || a.startDate || ''
      const tb = b.doneAt || b.deadline || b.startDate || ''
      return tb.localeCompare(ta)
    })
    .slice(0, 3)
)
const recentIds = computed(() => new Set(recentDone.value.map(p => p.id)))

const undatedProjects = computed(() =>
  props.projects.filter(p => !dateOf(p) && !recentIds.value.has(p.id))
)

const groupedByYear = computed(() => {
  const yearMap = new Map()
  for (const p of props.projects) {
    if (recentIds.value.has(p.id)) continue   // 已在「最近完成」置顶区
    const d = dateOf(p)
    if (!d) continue
    const y = String(d.getFullYear())
    const m = String(d.getMonth() + 1).padStart(2, '0') + '月'
    if (!yearMap.has(y)) yearMap.set(y, new Map())
    const mMap = yearMap.get(y)
    if (!mMap.has(m)) mMap.set(m, [])
    mMap.get(m).push(p)
  }
  return [...yearMap.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([year, mMap]) => ({
      year,
      total: [...mMap.values()].reduce((s, arr) => s + arr.length, 0),
      months: [...mMap.entries()]
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([month, items]) => ({ month, items })),
    }))
})

onMounted(() => {
  const now = new Date()
  const y = String(now.getFullYear())
  const m = String(now.getMonth() + 1).padStart(2, '0') + '月'
  openYears.value = new Set([y])
  openMonths.value = new Set([y + m])
})

function toggleYear(y) {
  const next = new Set(openYears.value)
  next.has(y) ? next.delete(y) : next.add(y)
  openYears.value = next
}
function toggleMonth(key) {
  const next = new Set(openMonths.value)
  next.has(key) ? next.delete(key) : next.add(key)
  openMonths.value = next
}

function onDrop(e) {
  isDragOver.value = false
  const id = Number(e.dataTransfer.getData('projectId'))
  if (id) emit('drop-project', { projectId: id, targetStatus: 'done' })
}
</script>

<style scoped>
/* 最近完成置顶区 */
.recent-done { margin-bottom: 10px; }
.recent-done-label {
  display: flex; align-items: center; gap: 5px;
  font-size: 11px; font-weight: 600; color: #5a9e88;
  padding: 0 2px 6px;
}
.recent-done .month-cards { display: flex; flex-direction: column; gap: 6px; }

.done-col {
  display: flex;
  flex-direction: column;
  background: rgba(255,255,255,0.18);
  border: 1px solid rgba(255,255,255,0.45);
  border-radius: var(--radius-lg);
  corner-shape: squircle;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.7);
  padding: 12px 10px;
  gap: 8px;
  min-height: 0;
  overflow: hidden;
  transition: background 0.15s, box-shadow 0.15s;
}
.done-col.drag-over {
  background: rgba(90,158,136,0.08);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.7), 0 0 0 2px rgba(90,158,136,0.25);
}

.col-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 4px; flex-shrink: 0;
}
.col-title {
  display: flex; align-items: center; gap: 7px;
  font-size: 13px; font-weight: 600; color: var(--text-primary);
}
.col-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: #5a9e88; flex-shrink: 0;
}
.col-count {
  font-size: 11px; font-weight: 700; color: #fff;
  background: rgba(123,127,178,0.42); border-radius: 20px;
  padding: 1px 7px; min-width: 22px; text-align: center;
}
.col-header-right {
  display: flex; align-items: center; gap: 8px;
}
.archived-entry-mini {
  display: flex; align-items: center; gap: 4px;
  padding: 2px 8px;
  border-radius: 7px;
  border: 1px solid rgba(0,0,0,0.08);
  background: rgba(255,255,255,0.5);
  color: var(--text-secondary);
  font-size: 11px; font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.archived-entry-mini:hover {
  background: rgba(255,255,255,0.85);
  color: var(--text-primary);
}

.col-body {
  display: flex; flex-direction: column; gap: 2px;
  flex: 1; overflow-y: auto;
  padding: 2px 6px 2px 6px;
  margin-right: -8px; padding-right: 14px;
  scrollbar-gutter: stable;
}
.col-body::-webkit-scrollbar { width: 3px; }
.col-body::-webkit-scrollbar-track { background: transparent; margin-top: 8px; margin-bottom: 8px; }
.col-body::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.1); border-radius: 99px; }

.col-empty {
  display: flex; align-items: center; justify-content: center;
  text-align: center; font-size: 12px; color: var(--text-secondary);
  opacity: 0.4; min-height: 96px; flex-shrink: 0;
  border: 1.5px dashed rgba(0,0,0,0.1);
  border-radius: var(--radius-md);
}

/* ── 年目录 ── */
.year-group { margin-bottom: 4px; }

.year-row {
  display: flex; align-items: center; gap: 6px;
  width: 100%; padding: 4px 6px;
  border: none; background: none;
  border-radius: 6px; cursor: pointer;
  font-family: var(--font-sans); text-align: left;
  transition: background 0.12s;
}
.year-row:hover { background: rgba(0,0,0,0.04); }

.year-chev {
  color: rgba(0,0,0,0.2);
  transition: transform 0.2s cubic-bezier(0.34,1.1,0.64,1);
  flex-shrink: 0;
}
.year-chev.open { transform: rotate(180deg); }

.year-label {
  font-size: 12px; font-weight: 700;
  color: rgba(0,0,0,0.62); flex: 1;
  letter-spacing: 0.03em;
}
.year-label.undated { color: rgba(0,0,0,0.4); }

.year-cnt {
  font-size: 10px; color: rgba(0,0,0,0.38);
}

.year-body {
  padding: 2px 0 2px 6px;
  border-left: 1px solid rgba(0,0,0,0.06);
  margin-left: 6px;
  margin-top: 1px;
}

/* ── 月目录 ── */
.month-group { margin-bottom: 1px; }

.month-row {
  display: flex; align-items: center; gap: 6px;
  width: 100%; padding: 4px 8px; border-radius: 7px;
  border: none; background: none; cursor: pointer;
  font-family: var(--font-sans); text-align: left;
  transition: background 0.12s;
}
.month-row:hover { background: rgba(0,0,0,0.04); }

.month-name {
  font-size: 11px; font-weight: 500;
  color: rgba(0,0,0,0.52); flex: 1;
}
.month-cnt {
  font-size: 10px; color: rgba(0,0,0,0.35);
}
.month-chev {
  color: rgba(0,0,0,0.22);
  transition: transform 0.16s;
}
.month-chev.open { transform: rotate(180deg); }

/* ── 项目卡片 ── */
.month-cards {
  display: flex; flex-direction: column; gap: 6px;
  padding: 4px 4px 4px 4px;
}
</style>
