<template>
  <div
    class="done-col glass-card"
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
        <TransitionGroup tag="div" name="done-group-list" class="done-section-list">
        <!-- 最近完成（置顶 3 个，直接可见，无需展开文件夹）-->
        <div v-if="recentDone.length" key="recent-done" class="recent-done">
          <div class="recent-done-label">
            <PhCheckCircle :size="12" weight="fill" style="color:#5a9e88" />
            最近完成
          </div>
          <TransitionGroup
            tag="div"
            name="done-card-list"
            class="month-cards recent-card-list"
          >
            <div v-for="p in recentDone" :key="p.id" class="done-card-item">
              <ProjectCard :project="p" @click="$emit('card-click', p)" />
            </div>
          </TransitionGroup>
        </div>

        <!-- 年目录：拆成 4 个独立 v-for——所有年份的 row、展开年份的 body、
             展开年内所有月份的 row、双层展开的 month-cards。
             Vue 3 编译器禁止在 <template v-for> 子元素上放 :key，且 v-for/v-if 同元素时
             v-if 拿不到 v-for 变量——所以把「过滤」挪到 computed 里，v-for 拿到的就是
             已经过滤好的列表。未展开的月份/卡片完全不渲染，保留原版「按需挂载」性能。
             4 个 v-for 各自作为 done-section-list / done-month-list 的直接子项，让
             Vue 给每个 sibling 注入稳定 key，触发 .done-group-list-move / .done-card-list-move 的 FLIP。 -->
        <button
          v-for="yg in groupedByYear"
          :key="`year-row-${yg.year}`"
          class="year-row"
          data-flip-target
          @click="toggleYear(yg.year)"
        >
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

        <TransitionGroup
          v-for="yg in openYearsList"
          :key="`year-body-${yg.year}`"
          tag="div"
          name="done-group-list"
          class="done-month-list"
        >
          <!-- TransitionGroup 要求每个直接子项对应单一、稳定 key 的根节点才能正确算 FLIP——
               之前用 <template v-for> 让每次循环产出两个兄弟根节点（.month-row + .month-folder），
               只在 template 上标 key，Vue 没法正确区分应该给哪个新增子项分哪个「位置槽」。
               本来没有月份文件夹（0个），一次性插入多个新月份时，Vue 分错槽位，视觉上就是
               月份文件夹叠在一起（2026-07-17 复现）。改成套一层 div.month-group 单一根节点，
               :key 直接放在这层上；display:contents 让它对布局透明，.month-row/.month-folder
               仍然是 .done-month-list 的实际 flex 子项，视觉不变。 -->
          <div v-for="mg in yg.months" :key="`month-group-${yg.year + mg.month}`" class="month-group">
            <button
              class="month-row"
              data-flip-target
              @click="toggleMonth(yg.year + mg.month)"
            >
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

            <Transition :name="animateFolders ? 'month-folder' : undefined">
              <div
                v-if="openMonths.has(yg.year + mg.month)"
                :key="`month-cards-${yg.year + mg.month}`"
                class="month-folder"
              >
                <TransitionGroup
                  tag="div"
                  name="done-card-list"
                  class="month-cards"
                  :css="false"
                >
                  <div v-for="p in mg.items" :key="p.id" class="done-card-item">
                    <ProjectCard :project="p" @click="$emit('card-click', p)" />
                  </div>
                </TransitionGroup>
              </div>
            </Transition>
          </div>
        </TransitionGroup>

        <!-- 未设置日期：跟年/月同款拆法——year-row 始终渲染（让折叠按钮跟其他年份
             一起做 FLIP），卡片组只在展开时挂载。同理避免在同一个元素上 v-for + v-if
             访问不到 v-for 变量的问题。 -->
        <button
          v-if="undatedProjects.length"
          :key="`year-row-undated`"
          class="year-row"
          @click="toggleYear('__undated')"
        >
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

        <TransitionGroup
          v-if="undatedProjects.length && openYears.has('__undated')"
          :key="`year-body-undated`"
          tag="div"
          name="done-card-list"
          class="month-cards"
        >
          <div v-for="p in undatedProjects" :key="p.id" class="done-card-item">
            <ProjectCard :project="p" @click="$emit('card-click', p)" />
          </div>
        </TransitionGroup>
        </TransitionGroup>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, type PropType } from 'vue'
import ProjectCard from './ProjectCard.vue'
import { PhFolder, PhFolderOpen, PhCheckCircle, PhArchive } from '@phosphor-icons/vue'
import type { Project } from '@/types/project'

const props = defineProps({
  projects: { type: Array as PropType<Project[]>, default: () => [] },
})
const emit = defineEmits(['card-click', 'drop-project', 'open-archived'])

const isDragOver  = ref(false)
// 在 setup 阶段就确定默认展开项，避免 onMounted 修改状态触发一次入场动画。
const initialYear = String(new Date().getFullYear())
const initialMonth = String(new Date().getMonth() + 1).padStart(2, '0') + '月'
const openYears   = ref(new Set<string>([initialYear]))
const openMonths  = ref(new Set<string>([initialYear + initialMonth]))
const animateFolders = ref(false)

function dateOf(p: Project) {
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

watch(() => props.projects.length, async (count) => {
  if (!count || animateFolders.value) return
  await nextTick()
  requestAnimationFrame(() => { animateFolders.value = true })
}, { immediate: true })

// recentDone 变化时手动 FLIP 年/月行位置——卡片从「最近完成」退出进入年月文件夹时，
// Vue TransitionGroup 的 FLIP 窗口已过（leave 动画结束后才触发位移），需要手动补偿。
watch(recentDone, async () => {
  // 记录变化前的位置（此时 DOM 还未更新）
  const rows = document.querySelectorAll<HTMLElement>('.year-row, .month-row')
  const beforeRects = Array.from(rows).map(el => el.getBoundingClientRect())
  // 等待 Vue 更新 DOM
  await nextTick()
  const afterRects = Array.from(rows).map(el => el.getBoundingClientRect())
  rows.forEach((el, i) => {
    const dx = beforeRects[i].left - afterRects[i].left
    const dy = beforeRects[i].top - afterRects[i].top
    if (dx || dy) {
      el.style.transform = `translate(${dx}px, ${dy}px)`
      el.style.transition = 'none'
      requestAnimationFrame(() => {
        el.style.transition = 'transform 0.34s cubic-bezier(0.34, 1.2, 0.64, 1)'
        el.style.transform = ''
      })
    }
  })
})

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

// 派生：「展开的年份」列表——给 v-for 用，避免在外层 v-for 上加 v-if 触发
// 「同元素 v-if 拿不到 v-for 变量」的 Vue 3 编译器规则。year-row 始终渲染（按年渲染），
// year-body TransitionGroup 只渲染展开的年份。openYearsList 的引用稳定时 Vue 不重新
// 重建 TransitionGroup，FLIP 移动照常跑。
const openYearsList = computed(() =>
  groupedByYear.value.filter(yg => openYears.value.has(yg.year))
)



function toggleYear(y: string) {
  const next = new Set(openYears.value)
  next.has(y) ? next.delete(y) : next.add(y)
  openYears.value = next
}
function toggleMonth(key: string) {
  const next = new Set(openMonths.value)
  next.has(key) ? next.delete(key) : next.add(key)
  openMonths.value = next
}

function onDrop(e: DragEvent) {
  isDragOver.value = false
  const id = Number(e.dataTransfer?.getData('projectId'))
  if (id) emit('drop-project', { projectId: id, targetStatus: 'done' })
}
</script>

<style scoped>
/* 最近完成置顶区 */
.recent-done { margin-bottom: 10px; }
.recent-done .month-cards {
  position: relative;
  padding: 4px 0;
  border-left: none;
  margin-left: 0;
}
.recent-done-label {
  display: flex; align-items: center; gap: 5px;
  font-size: 11px; font-weight: 600; color: #5a9e88;
  padding: 0 2px 6px;
}
.recent-done .month-cards { display: flex; flex-direction: column; gap: 6px; }

/* 玻璃质感走全局 .glass-card，跟另外两列（KanbanColumn）对齐同一档透明度——之前这里是
   本地写死的 0.18 且没有 backdrop-filter，是「统一玻璃透明度」那次改动漏掉的历史遗留。 */
.done-col {
  --glass-bg: rgba(255,255,255,0.25);
  --glass-bg-hover: rgba(255,255,255,0.25);
  display: flex;
  flex-direction: column;
  padding: 12px 10px;
  gap: 8px;
  min-height: 0;
  overflow: hidden;
}
.done-col.drag-over {
  background: rgba(90,158,136,0.08);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.7), 0 0 0 2px rgba(90,158,136,0.25);
}
/* FLIP 事务期间卡片会暂时越过 col-body 的可视边界；仅在协调器接管卡片时解除两层裁切，
   事务清理 data-flip-owner 后自动恢复正常滚动和圆角裁切。 */
.done-col:has([data-flip-owner="coordinator"]) {
  overflow: visible;
}
.done-col:has([data-flip-owner="coordinator"]) .col-body {
  overflow: visible;
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
  min-width: 0; box-sizing: border-box;
  overflow-x: hidden;
  /* 月份收起后滚动条消失时也保留同宽 gutter，避免整列卡片在一帧内横向挤压。 */
  scrollbar-gutter: stable;
  padding: 2px 6px;
  margin-right: 0;
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
/* 间距改挂到 year-row / month-row 自己身上——以前的 .year-group / .month-group 包装层
   已经被拆掉让 year-row 直接进 done-section-list 参与 FLIP，group 上的 margin-bottom
   自然失效；这里把同等视觉间距补回 row 上，避免拆完包装之后年 / 月之间挤成一团。 */
.year-row:not(:last-child) { margin-bottom: 4px; }
.done-section-list,
.done-year-list,
.done-month-list {
  display: flex;
  flex-direction: column;
  width: 100%;
}
/* .month-group 只是为了给 TransitionGroup 一个单一根节点当 key 用（见模板注释），
   display:contents 让它对 flex 布局透明——.month-row/.month-folder 仍然是
   .done-month-list 的实际 flex 子项，不会多出一层影响间距/换行的容器。 */
.month-group { display: contents; }
.done-group-list-enter-active,
.done-group-list-leave-active {
  transition: opacity 0.22s ease, transform 0.34s ease-in-out;
}
.done-group-list-enter-from,
.done-group-list-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
.done-group-list-move {
  /* 与拖拽物理 FLIP 使用同一缓动，避免卡片已让位而年月组仍滞后移动。 */
  transition: transform 0.34s cubic-bezier(0.22, 1, 0.36, 1) !important;
}
/* 月份内容通过 .month-folder 的实际高度收缩驱动后续月份移动；这里不要再叠加
   TransitionGroup 的 FLIP 位移，否则收起结束时会多补一次向上移动。 */
.done-month-list .done-group-list-move {
  transition: none !important;
  transform: none !important;
}
/* 月份文件夹自身由 month-folder 控制高度离场，不能再套用分组的 absolute/translate
   离场规则，否则下一个月份会在离场结束时额外上跳一段。 */
.done-month-list .done-group-list-leave-active {
  position: static;
  width: auto;
}
.done-month-list .done-group-list-leave-to {
  transform: none !important;
}
.done-group-list-leave-active {
  position: absolute;
  width: 100%;
  pointer-events: none;
}

.year-row {
  display: flex; align-items: center; gap: 6px;
  width: 100%; padding: 4px 6px;
  border: none; background: none;
  border-radius: 6px; cursor: pointer;
  font-family: var(--font-sans); text-align: left;
  transition: background 0.12s, transform 0.34s cubic-bezier(0.34, 1.2, 0.64, 1);
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
.month-row:not(:last-child) { margin-bottom: 1px; }

.month-row {
  display: flex; align-items: center; gap: 6px;
  width: 100%; padding: 4px 8px; border-radius: 7px;
  border: none; background: none; cursor: pointer;
  font-family: var(--font-sans); text-align: left;
  transition: background 0.12s, transform 0.34s cubic-bezier(0.34, 1.2, 0.64, 1);
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
  padding: 4px 0 4px 14px;
  border-left: 1px solid rgba(0,0,0,0.06);
  margin-left: 12px;
  box-sizing: border-box;
}
.month-folder {
  display: grid;
  grid-template-rows: 1fr;
  overflow: hidden;
  transform-origin: top;
}
.month-folder > .month-cards {
  min-height: 0;
  transition: padding 0.28s cubic-bezier(.22, 1, .36, 1);
}
.month-folder-enter-active,
.month-folder-leave-active {
  transition: grid-template-rows 0.28s cubic-bezier(.22, 1, .36, 1), padding 0.28s cubic-bezier(.22, 1, .36, 1), opacity 0.18s ease, transform 0.28s cubic-bezier(.22, 1, .36, 1);
}
.month-folder-enter-from,
.month-folder-leave-to {
  grid-template-rows: 0fr;
  opacity: 0;
  transform: translateY(-8px) scaleY(.92);
}
.month-folder-leave-to > .month-cards {
  padding-top: 0;
  padding-bottom: 0;
}
.done-card-item {
  flex: 0 0 auto;
  width: 100%;
}

/* 最近完成区与年/月列表的成员变化动画。拖拽中的物理克隆不在这些列表里，拖拽 FLIP
   仍由 interaction/drag 负责；卡片只处理自身进出，组内整体位移统一交给 year/month group。 */
.done-card-list-enter-active,
.done-card-list-leave-active {
  transition: opacity 0.22s ease, transform 0.34s cubic-bezier(0.34, 1.2, 0.64, 1);
}
.done-card-list-enter-from,
.done-card-list-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.98);
}
.recent-card-list .done-card-list-enter-from {
  /* 新进入最近完成区的卡片从列表下方补位，避免和月份列表顶部卡片重叠。 */
  transform: translateY(6px) scale(0.98);
}
.done-card-list-move {
  /* 不和 month-group 的整体 FLIP 叠加位移，避免文件夹 icon 与卡片各走一套时间轴。 */
  transition: none;
}
.done-card-list-leave-active {
  position: absolute;
  width: 100%;
  pointer-events: none;
}
.recent-card-list .done-card-list-leave-active {
  /* 卡片直接消失，不占空间，不触发 leave 动画 */
  display: none !important;
}
.done-month-list .done-card-list-leave-active {
  /* 跨到最近完成区的卡片在原月份中瞬间退出，让其余月份卡片单独完成让位。 */
  display: none !important;
}
.recent-card-list .done-card-list-leave-to {
  /* 不会被用到，因为 display:none 直接跳过 */
}

</style>
