<template>
  <BaseModal :show="show" width="480px" background="var(--panel-bg)" @close="$emit('close')">
    <div class="ap-modal">
      <div class="ap-header">
        <span class="ap-title">已归档项目</span>
        <button class="ap-close" @click="$emit('close')">
          <PhX :size="14" weight="bold" />
        </button>
      </div>

      <div ref="layoutRoot" class="ap-body">
        <!-- 只有真·首次（还没任何缓存数据）才显示加载态；已有数据后台静默刷新不再闪这个 -->
        <div v-if="projectStore.archivedLoading && !projectStore.archivedLoaded" class="ap-empty">加载中…</div>
        <div v-else-if="!projectStore.archivedProjects.length" class="ap-empty">暂无已归档项目</div>

        <template v-else>
          <!-- 年目录（同「已完成」列的年/月折叠约定）-->
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

            <div class="year-body" data-layout-content :data-layout-key="`year-${yg.year}`" :data-layout-open="openYears.has(yg.year) ? 'true' : 'false'">
              <div v-for="mg in yg.months" :key="mg.month" class="month-group">
                <button class="month-row" @click="toggleMonth(yg.year + mg.month)">
                  <PhFolderOpen v-if="openMonths.has(yg.year + mg.month)" :size="13" weight="fill" style="color:var(--color-primary); opacity:0.85; flex-shrink:0" />
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

                <div class="ap-list" data-layout-content :data-layout-key="yg.year + mg.month" :data-layout-open="openMonths.has(yg.year + mg.month) ? 'true' : 'false'">
                  <div v-for="p in mg.items" :key="p.id" class="ap-row">
                    <span class="ap-dot" :style="{ background: p.color }"></span>
                    <div class="ap-info">
                      <div class="ap-name">{{ p.name }}</div>
                      <div class="ap-sub">{{ p.client || '无客户' }} · {{ statusLabel(p.status) }}</div>
                    </div>
                    <button class="ap-restore" :disabled="restoringId === p.id" @click="restore(p.id)">
                      {{ restoringId === p.id ? '恢复中…' : '取消归档' }}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { PhX, PhFolder, PhFolderOpen } from '@phosphor-icons/vue'
import BaseModal from '@/components/common/BaseModal.vue'
import { runtime } from '@/interaction/runtime'
import { useProjectStore } from '@/stores/projects'
import type { Project } from '@/types/project'
import { naturalCompare } from '@/utils/textSort'

const props = defineProps({ show: { type: Boolean, default: false } })
const emit = defineEmits(['close'])

const projectStore = useProjectStore()
const restoringId = ref<number | null>(null)
const layoutRoot = ref<HTMLElement | null>(null)

const STATUS_LABELS: Record<string, string> = { pending: '待开始', active: '进行中', done: '已完成' }
function statusLabel(status: string) { return STATUS_LABELS[status] ?? status }

// 没有专门的「归档时间」字段，用 updatedAt（归档这个 PATCH 本身会刷新它）当分组依据
const openYears  = ref(new Set<string>())
const openMonths = ref(new Set<string>())
const defaultsInitialized = ref(false)

// BaseModal 的 slot 会在关闭过渡期间卸载；先由 Runtime 取消该根节点下的
// RAF/FLIP/height 动画，避免关闭归档弹窗后旧回调在下一次拖拽时补写样式。
watch(() => props.show, show => {
  if (!show && layoutRoot.value) runtime.cancelLayoutAnimations(layoutRoot.value)
})

const groupedByYear = computed(() => {
  const yearMap = new Map<string, Map<string, Project[]>>()
  for (const p of projectStore.archivedProjects) {
    const src = p.updatedAt || p.createdAt
    const d = src ? new Date(src) : new Date()
    const y = String(d.getFullYear())
    const m = String(d.getMonth() + 1).padStart(2, '0') + '月'
    if (!yearMap.has(y)) yearMap.set(y, new Map())
    const mMap = yearMap.get(y)!
    if (!mMap.has(m)) mMap.set(m, [])
    mMap.get(m)!.push(p)
  }
  const years = [...yearMap.entries()]
    .sort(([a], [b]) => naturalCompare(b, a))
    .map(([year, mMap]) => ({
      year,
      total: [...mMap.values()].reduce((s, arr) => s + arr.length, 0),
      months: [...mMap.entries()]
        .sort(([a], [b]) => naturalCompare(b, a))
        .map(([month, items]) => ({ month, items })),
    }))
  return years
})

// 默认状态只能初始化一次，不能放在 groupedByYear computed 内；否则用户把
// 最后一个年组收起后，computed 再求值会把它自动设回展开，表现为“只能收起、不能展开”。
watch(groupedByYear, years => {
  if (defaultsInitialized.value || years.length === 0) return
  defaultsInitialized.value = true
  openYears.value = new Set([years[0].year])
  if (years[0].months.length) {
    openMonths.value = new Set([years[0].year + years[0].months[0].month])
  }
}, { immediate: true })

function toggleYearState(y: string) {
  const next = new Set(openYears.value)
  next.has(y) ? next.delete(y) : next.add(y)
  openYears.value = next
}
function toggleMonthState(key: string) {
  const next = new Set(openMonths.value)
  next.has(key) ? next.delete(key) : next.add(key)
  openMonths.value = next
}

async function runGroupToggle(key: string, opening: boolean, mutate: () => void) {
  const root = layoutRoot.value
  const content = root?.querySelector<HTMLElement>(`[data-layout-key="${CSS.escape(key)}"]`)
  if (!root || !content) {
    mutate()
    return
  }
  await runtime.runGroupToggle({
    root,
    content,
    opening,
    mutate,
    waitForLayout: nextTick,
    duration: 250,
    easing: 'cubic-bezier(.22,1,.36,1)',
  })
}

function toggleYear(y: string) {
  void runGroupToggle(`year-${y}`, !openYears.value.has(y), () => toggleYearState(y))
}
function toggleMonth(key: string) {
  void runGroupToggle(key, !openMonths.value.has(key), () => toggleMonthState(key))
}

async function restore(id: number) {
  restoringId.value = id
  try {
    await projectStore.unarchiveProject(id)
  } finally {
    restoringId.value = null
  }
}
</script>

<style scoped>
.ap-modal { display: flex; flex-direction: column; max-height: 70vh; }
.ap-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 18px; border-bottom: 1px solid rgba(0,0,0,0.06); flex-shrink: 0;
}
.ap-title { font-size: 15px; font-weight: 700; color: var(--text-primary); }
.ap-close {
  width: 26px; height: 26px; border-radius: 8px; border: none; background: none;
  color: var(--text-secondary); display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.15s;
}
.ap-close:hover { background: rgba(0,0,0,0.08); }

.ap-body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px 16px; }
.ap-empty {
  padding: 32px 0; text-align: center; color: var(--text-secondary); font-size: 13px;
}

/* ── 年目录（同「已完成」列约定）── */
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
.year-label { font-size: 12px; font-weight: 700; color: rgba(0,0,0,0.62); flex: 1; letter-spacing: 0.03em; }
.year-cnt { font-size: 10px; color: rgba(0,0,0,0.38); }
.year-body {
  padding: 2px 0 2px 6px;
  border-left: 1px solid rgba(0,0,0,0.06);
  margin-left: 6px; margin-top: 1px;
  min-height: 0; overflow: hidden;
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
.month-name { font-size: 11px; font-weight: 500; color: rgba(0,0,0,0.52); flex: 1; }
.month-cnt { font-size: 10px; color: rgba(0,0,0,0.35); }
.month-chev { color: rgba(0,0,0,0.22); transition: transform 0.16s; }
.month-chev.open { transform: rotate(180deg); }

/* ── 项目行 ── */
.ap-list { display: flex; flex-direction: column; gap: 4px; padding: 4px 0 4px 4px; min-height: 0; overflow: hidden; }
.year-body[data-layout-open="false"]:not([data-runtime-group-animating="true"]),
.ap-list[data-layout-open="false"]:not([data-runtime-group-animating="true"]) { height: 0; overflow: hidden; }
.ap-row {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 10px; border-radius: 10px; transition: background 0.12s;
}
.ap-row:hover { background: rgba(255,255,255,0.55); }
.ap-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
.ap-info { flex: 1; min-width: 0; }
.ap-name {
  font-size: 13px; font-weight: 600; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ap-sub { font-size: 11px; color: var(--text-secondary); margin-top: 1px; }
.ap-restore {
  flex-shrink: 0; font-size: 12px; font-weight: 600; padding: 5px 10px;
  border-radius: 8px; border: 1px solid rgba(123,127,178,0.35);
  background: rgba(123,127,178,0.08); color: var(--color-primary, #7b7fb2);
  cursor: pointer; transition: background 0.15s;
}
.ap-restore:hover:not(:disabled) { background: rgba(123,127,178,0.18); }
.ap-restore:disabled { opacity: 0.6; cursor: default; }
</style>
