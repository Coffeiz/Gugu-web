<template>
  <div class="rec-layout">
    <!-- 便签流滚动区（自己管滚动：full-bleed 下 page-content 不滚） -->
    <div ref="scrollRef" class="rec-scroll">
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
      <!-- 给底部停靠的捕捉条让出空间，最后一条便签才不会被盖住 -->
      <div class="rec-bottom-pad"></div>
    </div>

    <DateIndex :groups="indexGroups" :active="activeDate" @jump="jumpTo" />

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

// ── 日期索引：滚动联动（IntersectionObserver 盯日期组，别用 scroll 手算）──────
const indexGroups = computed(() => store.timeline.map(g => ({ date: g.date, count: g.items.length })))
const activeDate  = ref('')
let observer: IntersectionObserver | null = null
const visibleTops = new Map<string, number>()   // date -> boundingTop（只记相交中的组）

function rebuildObserver() {
  observer?.disconnect()
  visibleTops.clear()
  const root = scrollRef.value
  if (!root) return
  observer = new IntersectionObserver(entries => {
    for (const en of entries) {
      const date = (en.target as HTMLElement).dataset.date!
      if (en.isIntersecting) visibleTops.set(date, en.boundingClientRect.top)
      else visibleTops.delete(date)
    }
    // 当前 = 顶部条带里位置最靠上的组；条带里没有（快速滚动间隙）就保持上次的值
    let best = ''; let bestTop = Infinity
    for (const [date, top] of visibleTops) {
      if (top < bestTop) { best = date; bestTop = top }
    }
    if (best) activeDate.value = best
  }, { root, rootMargin: '0px 0px -70% 0px' })
  root.querySelectorAll<HTMLElement>('.tl-group[data-date]').forEach(el => observer!.observe(el))
}

watch(() => store.timeline, async () => { await nextTick(); rebuildObserver() }, { immediate: true })
onBeforeUnmount(() => observer?.disconnect())

function jumpTo(date: string) {
  scrollRef.value?.querySelector<HTMLElement>(`.tl-group[data-date="${date}"]`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// ── 新建：翻进历史 → 先滚回顶部再插入+高亮；补录 → 不滚，toast 报落点 ─────────
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
    // 补录落进上方很远的日期组，底部不会有任何动静——不给反馈用户会以为没保存
    const [, m, d] = capturedAt.slice(0, 10).split('-')
    Message.success(`已记到 ${+m} 月 ${+d} 日`)
    return
  }
  scrollRef.value?.scrollTo({ top: 0, behavior: 'smooth' })
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
  display: flex; gap: 14px; min-height: 0;
}

.rec-scroll {
  flex: 1; min-width: 0; overflow-y: auto;
  scrollbar-gutter: stable;
  padding: 2px 6px 0 2px;
}
/* 便签流本体宽度：双列在 ~980px 里最舒服，超宽屏不无限拉伸 */
.rec-scroll > * { max-width: 980px; }
.rec-bottom-pad { height: 96px; }

.rec-loading { padding: 40px 0; text-align: center; font-size: 12.5px; color: var(--text-secondary); }

/* 捕捉条：停靠在布局底部（视口内常驻），盖在滚动区之上、与便签流对齐 */
.rec-capture {
  position: absolute; bottom: 6px; left: 2px;
  width: min(100% - 140px, 720px);
  z-index: 8;
}
@media (max-width: 900px) {
  .rec-capture { width: calc(100% - 12px); }
}
</style>
