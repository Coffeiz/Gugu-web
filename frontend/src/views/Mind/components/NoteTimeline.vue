<template>
  <!-- 横置时间流：一天一列（左旧右新，今天在最右），列内便签上新下旧。
       没便签的日期不出列——时间轴压缩，不摆空列。列内溢出自己竖滚。
       每列一块玻璃底板（同定时任务 .panel.glass-card 的轻玻璃，背后是静态页面背景，安全）。 -->
  <div class="timeline-cols">
    <section v-for="(g, i) in groups" :key="g.date" v-memo="[dayMemo(g), columnVisualKey(i)]" class="tl-col glass-card" :data-date="g.date" :style="columnStyle(i)">
      <div class="tl-col-head">
        <span class="tl-day" :class="{ today: g.date === todayIso }">{{ +g.date.slice(8, 10) }}</span>
        <span class="tl-day-side">
          <span class="tl-month">{{ monthLabel(g.date) }}</span>
          <span class="tl-week">{{ weekdayOf(g.date) }}</span>
        </span>
        <span class="tl-count">{{ g.items.length }}</span>
      </div>

      <div class="tl-col-body">
        <div class="note-stack">
          <NoteCard
            v-for="n in g.items"
            :key="n.id"
            :note="n"
            :editing="editingId === n.id"
            :highlight="highlightId === n.id"
            :conflict="editingId === n.id && conflict"
            @edit="startEdit(n)"
            @close="stopEditing"
            @save="md => autosave(n, md)"
            @delete="emit('delete', n)"
            @color="c => emit('color', n, c)"
            @toggle-task="idx => emit('toggleTask', n, idx)"
          />
        </div>
      </div>
    </section>
  </div>

  <div v-if="!groups.length" class="tl-empty">
    {{ filtered ? '没有匹配的笔记' : '还没有记录，在下面记一条试试～' }}
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { MindNote } from '@/services/api'
import { localDayKey } from '@/utils/dateAttribution'
import NoteCard from './NoteCard.vue'

const props = defineProps<{
  groups: { date: string; items: MindNote[] }[]
  centerFrac: number
  highlightId: number | null
  filtered: boolean
}>()
const emit = defineEmits<{
  (e: 'save', note: MindNote, md: string): void
  (e: 'delete', note: MindNote): void
  (e: 'color', note: MindNote, color: string | null): void
  (e: 'toggleTask', note: MindNote, idx: number): void
  (e: 'editRequest', note: MindNote): void
}>()

const editingId = ref<number | null>(null)
const conflict  = ref(false)

// 编辑态强制绑定"当前居中的日期"：点哪张卡不直接进编辑，先把请求交给 NotesView.vue——
// 那张卡所在的日期正好居中就立刻走 confirmEdit；不居中就先把那天滚到正中，稳定之后
// NotesView 再回调 confirmEdit（见 NotesView.vue 的 onEditRequest/onScrollEnd）。
function startEdit(n: MindNote) {
  emit('editRequest', n)
}
/** 真正进入编辑态，只有确认目标日期已经居中才会被调用（见上面 startEdit 的说明）。 */
function confirmEdit(n: MindNote) {
  editingId.value = n.id
  conflict.value = false
}
/** 点卡外面/切到别的便签/居中日期变了都退出编辑态；自动保存本身不退出——写着写着还在存，
 *  不能把人踢出去。 */
function stopEditing() { editingId.value = null; conflict.value = false }
function autosave(n: MindNote, md: string) {
  emit('save', n, md)
}

/** 未变化的日期列完全跳过 patch，补录其它日期不会触发已有便签的列表移动计算。 */
function dayMemo(group: { date: string; items: MindNote[] }) {
  const versions = group.items.map(note => `${note.id}:${note.version}`).join('|')
  const highlighted = group.items.some(note => note.id === props.highlightId) ? props.highlightId : ''
  const editing = group.items.some(note => note.id === editingId.value) ? editingId.value : ''
  return `${versions};h:${highlighted};e:${editing};c:${editing ? conflict.value : ''}`
}

/** 真实列坐标不变，只压缩视觉卡片：越远越小、越靠中心越密，边缘沉到后方。 */
function columnStyle(index: number) {
  const distance = Math.abs(index - props.centerFrac)
  const capped = Math.min(distance, 5)
  const direction = index === props.centerFrac ? 0 : index < props.centerFrac ? 1 : -1
  // 列本身的布局步长是 COL_WIDTH 宽 + 14px 间距；视觉中心距按缩放后的卡宽压缩，避免缩小后
  // 留白。每段步长依次收窄（1x→0.825x→0.6x→0.375x，跟 COL_WIDTH 成比例），越往边缘挤得
  // 越紧，不是匀速压缩——这组比例是调过的视觉曲线，改 COL_WIDTH（连带改 CSS .tl-col 的
  // width）时这里跟着等比例缩放，不用重新调。
  const COL_WIDTH = 440   // 须跟 CSS .tl-col 的 width 保持一致
  const desiredDistance = capped <= 1
    ? capped * COL_WIDTH
    : capped <= 2
      ? COL_WIDTH + (capped - 1) * COL_WIDTH * 0.825
      : capped <= 3
        ? COL_WIDTH * 1.825 + (capped - 2) * COL_WIDTH * 0.6
        : COL_WIDTH * 2.425 + (capped - 3) * COL_WIDTH * 0.375
  const compression = capped * (COL_WIDTH + 14) - desiredDistance
  // 景深模糊：中间清晰、越靠两侧越糊，跟压缩/缩放同一个 capped 距离驱动，不需要额外状态。
  // 排查过：去掉这层 filter 白块依然在，不是它的锅，恢复回来。
  const depthBlur = capped * 0.35
  return {
    transform: `translateX(${direction * compression}px) scale(${1 - capped * 0.055})`,
    filter: `blur(${depthBlur}px)`,
    zIndex: `${100 - Math.round(capped * 10)}`,
  }
}

/** 只有中心附近的列随连续位置重绘；远侧卡片维持同一压缩状态。 */
function columnVisualKey(index: number) {
  const distance = index - props.centerFrac
  if (Math.abs(distance) >= 5) return distance < 0 ? 'far-left' : 'far-right'
  return Math.round(distance * 100) / 100
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六']
const todayIso = localDayKey(new Date())   // 本地今天（不是 UTC）

/** 月份小字：同年只显「7月」，跨年带年份「25年12月」 */
function monthLabel(iso: string) {
  const [y, m] = iso.split('-')
  return y === todayIso.slice(0, 4) ? `${+m}月` : `${y.slice(2)}年${+m}月`
}
function weekdayOf(iso: string) { return '周' + WEEK[new Date(iso + 'T00:00:00').getDay()] }

defineExpose({ flagConflict: () => { conflict.value = true }, confirmEdit, stopEditing })
</script>

<style scoped>
.timeline-cols {
  display: flex; gap: 14px; align-items: stretch;
  height: 100%; min-width: max-content;
  /* 两端留白和 NotesView.contentCenter() 共享实测坐标。CSS 的 vw/sidebar 公式只作首帧
     fallback；挂载后由 JS 写入同一坐标系的像素值，单列也不再受估算误差影响。 */
  padding-top: 2px;
  padding-left: var(--timeline-left-gutter, calc(var(--sidebar-width) / 2 + 50vw - 220px));
  padding-right: var(--timeline-right-gutter, calc(var(--sidebar-width) + 50vw - 220px + 300px));
  /* 拖到第一天/最后一天之外的橡皮筋超出量画在这个 transform 上（见 NotesView.vue 的
     onColumnsPointerMove/onColumnsPointerUp）：拖动中 JS 直接赋值跟手，不走这条过渡；
     松手后的回弹由 NotesView 的同一套阻尼弹簧逐帧驱动，不能在这里再叠一层 CSS 缓动。 */
}

/* 一天一块玻璃底板：轻玻璃（同定时任务面板 --glass-bg 0.25），hover 不提亮（底板不是交互件） */
.tl-col {
  --glass-bg: rgba(255,255,255,0.25);
  --glass-bg-hover: rgba(255,255,255,0.25);
  /* isolation:isolate 给每张卡一个独立、稳定的合成层边界，不被页面其它地方（比如日历
     弹层里跟卡片重叠的那一角）的重绘牵连——本仓库处理 backdrop-filter 玻璃层怪异重绘
     早就用过这招（topbar/GuguChat 悬浮球），这里同样的坑先按同样的方子试一次。 */
  isolation: isolate;
  border-radius: 40px;
  corner-shape: squircle;
  width: 440px; flex-shrink: 0; box-sizing: border-box;
  display: flex; flex-direction: column; min-height: 0; position: relative;
  padding: 14px 12px 10px;
  scroll-snap-align: center;   /* 滚列时磁吸：列中心吸到 scroll-padding 调整后的中线（=contentCenter，#4）*/
  transform-origin: center center;
}
/* 深度效果的平滑现在完全交给 NotesView.vue 的 timelineVisualFrac 低通滤波（每帧直接
   算出目标 transform）；这里不再叠一层 CSS transition——continuously 变化的值用 transition
   会变成「一直在追一个每帧都挪的目标」，反而比单纯的 JS 平滑更容易看着发飘、跟不上。 */
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
.note-stack { display: flex; flex-direction: column; gap: 10px; }

.tl-empty {
  align-self: flex-start;
  padding: 48px 24px; font-size: 12.5px; color: var(--text-secondary);
}
</style>
