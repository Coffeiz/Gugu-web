<template>
  <!-- 横置时间流：一天一列（左旧右新，今天在最右），列内便签上新下旧。
       没便签的日期不出列——时间轴压缩，不摆空列。列内溢出自己竖滚。
       每列一块玻璃底板（同定时任务 .panel.glass-card 的轻玻璃，背后是静态页面背景，安全）。 -->
  <div class="timeline-cols">
    <section v-for="g in groups" :key="g.date" v-memo="[dayMemo(g)]" class="tl-col glass-card" :data-date="g.date">
      <div class="tl-col-head">
        <span class="tl-day" :class="{ today: g.date === todayIso }">{{ +g.date.slice(8, 10) }}</span>
        <span class="tl-day-side">
          <span class="tl-month">{{ monthLabel(g.date) }}</span>
          <span class="tl-week">{{ weekdayOf(g.date) }}</span>
        </span>
        <span class="tl-count">{{ g.items.length }}</span>
      </div>

      <div class="tl-col-body">
        <div class="tl-stack">
          <NoteCard
            v-for="n in g.items"
            :key="n.id"
            :note="n"
            :editing="editingId === n.id"
            :highlight="highlightId === n.id"
            :conflict="editingId === n.id && conflict"
            @edit="startEdit(n)"
            @cancel="cancel"
            @save="md => commit(n, md)"
            @delete="emit('delete', n)"
            @toggle-task="idx => emit('toggleTask', n, idx)"
          />
        </div>
      </div>
    </section>
  </div>

  <div v-if="!groups.length" class="tl-empty">
    {{ filtered ? '没有匹配的便签' : '还没有记录，在下面记一条试试～' }}
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { MindNote } from '@/services/api'
import NoteCard from './NoteCard.vue'

const props = defineProps<{
  groups: { date: string; items: MindNote[] }[]
  highlightId: number | null
  filtered: boolean
}>()
const emit = defineEmits<{
  (e: 'save', note: MindNote, md: string): void
  (e: 'delete', note: MindNote): void
  (e: 'toggleTask', note: MindNote, idx: number): void
}>()

const editingId = ref<number | null>(null)
const conflict  = ref(false)

function startEdit(n: MindNote) {
  editingId.value = n.id
  conflict.value = false
}
function cancel() { editingId.value = null; conflict.value = false }
function commit(n: MindNote, md: string) {
  emit('save', n, md)
  editingId.value = null
}

/** 未变化的日期列完全跳过 patch，补录其它日期不会触发已有便签的列表移动计算。 */
function dayMemo(group: { date: string; items: MindNote[] }) {
  const versions = group.items.map(note => `${note.id}:${note.version}`).join('|')
  const highlighted = group.items.some(note => note.id === props.highlightId) ? props.highlightId : ''
  const editing = group.items.some(note => note.id === editingId.value) ? editingId.value : ''
  return `${versions};h:${highlighted};e:${editing};c:${editing ? conflict.value : ''}`
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六']
const todayIso = new Date().toISOString().slice(0, 10)

/** 月份小字：同年只显「7月」，跨年带年份「25年12月」 */
function monthLabel(iso: string) {
  const [y, m] = iso.split('-')
  return y === todayIso.slice(0, 4) ? `${+m}月` : `${y.slice(2)}年${+m}月`
}
function weekdayOf(iso: string) { return '周' + WEEK[new Date(iso + 'T00:00:00').getDay()] }

defineExpose({ flagConflict: () => { conflict.value = true } })
</script>

<style scoped>
.timeline-cols {
  display: flex; gap: 14px; align-items: stretch;
  height: 100%; min-width: max-content;
  /* 两端留白让首末列也能停在「内容区中线」（不是视口中线——滚动容器铺满视口宽但要跟
     上方胶囊/滑杆的居中对齐）。内容区中线 = (侧栏宽 + 视口)/2 = 侧栏宽/2 + 50vw；
     半列宽 170（= .tl-col 340px 的一半）。左 padding = 中线 - 半列；右 padding = 视口 - 中线 - 半列。 */
  padding-top: 2px;
  padding-left: calc(var(--sidebar-width) / 2 + 50vw - 170px);
  padding-right: calc(50vw - var(--sidebar-width) / 2 - 170px);
}

/* 一天一块玻璃底板：轻玻璃（同定时任务面板 --glass-bg 0.25），hover 不提亮（底板不是交互件） */
.tl-col {
  --glass-bg: rgba(255,255,255,0.25);
  --glass-bg-hover: rgba(255,255,255,0.25);
  width: 340px; flex-shrink: 0; box-sizing: border-box;
  display: flex; flex-direction: column; min-height: 0;
  padding: 14px 12px 10px;
  scroll-snap-align: center;   /* 滚列时磁吸：列中心吸到 scroll-padding 调整后的中线（=contentCenter，#4）*/
}
/* 日期头：大数字 + 小字月份/星期（周视图日历的语言） */
.tl-col-head {
  display: flex; align-items: center; gap: 8px;
  flex-shrink: 0; padding: 0 4px 10px;
}
.tl-day {
  font-size: 26px; font-weight: 700; line-height: 1;
  color: var(--text-primary); font-variant-numeric: tabular-nums;
}
.tl-day.today { color: var(--color-primary); }
.tl-day-side { display: flex; flex-direction: column; gap: 1px; }
.tl-month { font-size: 11px; font-weight: 600; color: var(--text-secondary); line-height: 1.1; }
.tl-week  { font-size: 10.5px; color: var(--text-secondary); opacity: 0.75; line-height: 1.1; }
.tl-count {
  margin-left: auto; font-size: 10.5px; color: var(--text-secondary);
  background: rgba(123,127,178,0.1); border-radius: 99px; padding: 1px 7px;
}

/* 列内溢出自己竖滚（横向翻历史、纵向翻当天，互不打架） */
.tl-col-body {
  flex: 1; min-height: 0; overflow-y: auto;
  /* 横向视口外的便签堆不参与绘制；列框与宽度仍保留，日期滑杆的定位几何不会改变。 */
  content-visibility: auto;
  contain-intrinsic-size: auto 560px;
  scrollbar-width: thin;
  margin: 0 -4px; padding: 2px 4px 4px;
}
.tl-stack { display: flex; flex-direction: column; gap: 10px; }

.tl-empty {
  align-self: flex-start;
  padding: 48px 24px; font-size: 12.5px; color: var(--text-secondary);
}
</style>
