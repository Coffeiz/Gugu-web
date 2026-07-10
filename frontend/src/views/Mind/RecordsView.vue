<template>
  <div class="rec-layout">
    <!-- 顶部日期条（胶囊下方）：横向索引，滚动联动 + 点击跳列 -->
    <DateIndex :groups="indexGroups" :active="activeDate" @jump="jumpTo" />

    <!-- 横置便签流：横向翻历史（滚轮转横滚），列内竖滚翻当天 -->
    <div ref="scrollRef" class="rec-hscroll" @wheel="onWheel">
      <div v-if="store.loading && !store.loaded" class="rec-loading">加载中…</div>
      <RecordTimeline
        v-else
        ref="timelineRef"
        :groups="store.timeline"
        :highlight-id="highlightId"
        :filtered="!!store.filterQ.trim()"
        @save="onSave"
        @delete="onDelete"
        @toggle-task="onToggleTask"
      />
    </div>

    <div class="rec-capture">
      <CaptureBar @created="onCreated" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import { useLiveStore } from '@/stores/live'
import { MindConflictError, useMindStore } from '@/stores/mind'
import { toggleTaskInMd } from '@/composables/useMindEditor'
import type { MindNote } from '@/services/api'
import CaptureBar from './components/CaptureBar.vue'
import DateIndex from './components/DateIndex.vue'
import RecordTimeline from './components/RecordTimeline.vue'

const store     = useMindStore()
const liveStore = useLiveStore()
const timelineRef = ref<InstanceType<typeof RecordTimeline> | null>(null)
const scrollRef   = ref<HTMLElement | null>(null)

const highlightId = ref<number | null>(null)
let highlightTimer: ReturnType<typeof setTimeout> | null = null

onMounted(async () => {
  if (!store.loaded) store.fetchNotes()
  // 重访本页时 timeline 内容没变、下面的 watch 不会触发，挂载后补一次观察器
  await nextTick()
  rebuildObserver()
})

// 咕咕/多端改了便签 → 重新拉（P3 后端才开始推 mind 资源，这里先接好）
watch(() => liveStore.rev.mind, () => store.fetchNotes())

// ── 滚轮：悬在有溢出的列上→列内竖滚（浏览器默认）；否则纵滚轮转横滚（翻历史）──
function onWheel(e: WheelEvent) {
  const root = scrollRef.value
  if (!root) return
  if (e.deltaX || e.shiftKey) return   // 触控板横扫/Shift+滚轮：浏览器自己会横滚
  const colBody = (e.target as HTMLElement).closest<HTMLElement>('.tl-col-body')
  if (colBody && colBody.scrollHeight > colBody.clientHeight + 2) return
  root.scrollLeft += e.deltaY
  e.preventDefault()
}

// ── 日期条：滚动联动（IntersectionObserver 盯日期列，别用 scroll 手算）────────
const indexGroups = computed(() => store.timeline.map(g => ({ date: g.date, count: g.items.length })))
const activeDate  = ref('')
let observer: IntersectionObserver | null = null
const visibleLefts = new Map<string, number>()   // date -> boundingLeft（只记相交中的列）

function rebuildObserver() {
  observer?.disconnect()
  visibleLefts.clear()
  const root = scrollRef.value
  if (!root) return
  observer = new IntersectionObserver(entries => {
    for (const en of entries) {
      const date = (en.target as HTMLElement).dataset.date!
      if (en.isIntersecting) visibleLefts.set(date, en.boundingClientRect.left)
      else visibleLefts.delete(date)
    }
    // 当前 = 左侧条带里位置最靠左的列；条带里没有（快速滚动间隙）就保持上次的值
    let best = ''; let bestLeft = Infinity
    for (const [date, left] of visibleLefts) {
      if (left < bestLeft) { best = date; bestLeft = left }
    }
    if (best) activeDate.value = best
  }, { root, rootMargin: '0px -60% 0px 0px' })
  root.querySelectorAll<HTMLElement>('.tl-col[data-date]').forEach(el => observer!.observe(el))
}

watch(() => store.timeline, async () => { await nextTick(); rebuildObserver() }, { immediate: true })
onBeforeUnmount(() => observer?.disconnect())

function jumpTo(date: string) {
  const root = scrollRef.value
  const col = root?.querySelector<HTMLElement>(`.tl-col[data-date="${date}"]`)
  if (root && col) root.scrollTo({ left: col.offsetLeft - 4, behavior: 'smooth' })
}

// ── 新建：翻进历史 → 先滚回最左（今天）再插入+高亮；补录 → 不滚，toast 报落点 ──
const _today = () => new Date().toISOString().slice(0, 10)

async function onCreated(md: string, capturedAt?: string) {
  let created: MindNote
  try {
    created = await store.createNote({ contentMd: md, capturedAt })
  } catch {
    Message.error('记录失败，请重试')
    return
  }
  if (capturedAt && capturedAt.slice(0, 10) !== _today()) {
    // 补录落进右边很远的日期列，眼前不会有任何动静——不给反馈用户会以为没保存
    const [, m, d] = capturedAt.slice(0, 10).split('-')
    Message.success(`已记到 ${+m} 月 ${+d} 日`)
    return
  }
  scrollRef.value?.scrollTo({ left: 0, behavior: 'smooth' })
  highlightId.value = created.id
  if (highlightTimer) clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => { highlightId.value = null }, 1800)
}

async function onSave(note: MindNote, md: string) {
  try {
    await store.updateNote(note.id, { contentMd: md, version: note.version })
  } catch (e) {
    if (e instanceof MindConflictError) {
      // 乐观锁撞车：别覆盖别人的改动，拉最新回来让用户重看
      timelineRef.value?.flagConflict()
      await store.fetchNotes()
      Message.warning('这条便签已被其他端修改，已刷新为最新内容')
    } else {
      Message.error('保存失败，请重试')
    }
  }
}

/** 卡上直接勾待办：翻转第 idx 个任务再走同一条乐观锁保存路径 */
async function onToggleTask(note: MindNote, idx: number) {
  await onSave(note, toggleTaskInMd(note.contentMd, idx))
}

async function onDelete(note: MindNote) {
  try {
    await store.deleteNote(note.id)
  } catch {
    Message.error('删除失败，请重试')
  }
}
</script>

<style scoped>
.rec-layout {
  position: relative; height: 100%;
  display: flex; flex-direction: column; gap: 8px; min-height: 0;
}

.rec-hscroll {
  flex: 1; min-height: 0; min-width: 0;
  overflow-x: auto; overflow-y: hidden;
  /* 横向导航靠滚轮/触控板/日期条，滚动条藏掉（露在捕捉条底下很脏） */
  scrollbar-width: none;
  padding-bottom: 96px;   /* 给底部停靠的捕捉条让空间，最左列底部的卡不被盖住 */
}
.rec-hscroll::-webkit-scrollbar { display: none; }

.rec-loading { padding: 40px 24px; font-size: 12.5px; color: var(--text-secondary); }

/* 捕捉条：停靠底部、水平居中（与居中胶囊呼应）。
   18px + fullBleed 的 10px 内边距 = 视口底 28px，与咕咕悬浮球（.ai-fab bottom:28px）齐平 */
.rec-capture {
  position: absolute; bottom: 18px; left: 0; right: 0;
  margin: 0 auto;
  width: min(100% - 24px, 680px);
  z-index: 8;
}
</style>
