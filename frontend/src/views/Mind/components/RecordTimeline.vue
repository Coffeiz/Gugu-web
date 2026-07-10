<template>
  <!-- 横置时间流：一天一列（左新右旧，今天在最左），列内便签上新下旧。
       没便签的日期不出列——时间轴压缩，不摆空列。列内溢出自己竖滚。 -->
  <div class="timeline-cols">
    <section v-for="g in groups" :key="g.date" class="tl-col" :data-date="g.date">
      <div class="tl-col-head">
        <span class="tl-date-main">{{ fmtDate(g.date) }}</span>
        <span class="tl-date-sub">{{ weekdayOf(g.date) }}</span>
        <span class="tl-count">{{ g.items.length }}</span>
      </div>

      <div class="tl-col-body">
        <TransitionGroup tag="div" class="tl-stack" name="tlc">
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
        </TransitionGroup>
      </div>
    </section>

    <div v-if="!groups.length" class="tl-empty">
      {{ filtered ? '没有匹配的便签' : '还没有记录，在下面记一条试试～' }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { MindNote } from '@/services/api'
import NoteCard from './NoteCard.vue'

defineProps<{
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

const WEEK = ['日', '一', '二', '三', '四', '五', '六']
const _today = new Date().toISOString().slice(0, 10)

function fmtDate(iso: string) {
  if (iso === _today) return '今天'
  const [y, m, d] = iso.split('-')
  const thisYear = _today.slice(0, 4)
  return y === thisYear ? `${+m} 月 ${+d} 日` : `${y} 年 ${+m} 月 ${+d} 日`
}
function weekdayOf(iso: string) { return '周' + WEEK[new Date(iso + 'T00:00:00').getDay()] }

defineExpose({ flagConflict: () => { conflict.value = true } })
</script>

<style scoped>
.timeline-cols {
  display: flex; gap: 14px; align-items: stretch;
  height: 100%; min-width: max-content;
  padding: 2px 2px 0;
}

.tl-col {
  width: 280px; flex-shrink: 0;
  display: flex; flex-direction: column; min-height: 0;
}
.tl-col-head {
  display: flex; align-items: baseline; gap: 7px;
  flex-shrink: 0; padding: 0 2px 8px;
}
.tl-date-main { font-size: 13px; font-weight: 700; color: var(--text-primary); }
.tl-date-sub  { font-size: 11px; color: var(--text-secondary); }
.tl-count {
  margin-left: auto; font-size: 10.5px; color: var(--text-secondary);
  background: rgba(123,127,178,0.1); border-radius: 99px; padding: 1px 7px;
}

/* 列内溢出自己竖滚（横向翻历史、纵向翻当天，互不打架） */
.tl-col-body {
  flex: 1; min-height: 0; overflow-y: auto;
  scrollbar-width: thin;
  padding: 1px 2px 4px;
}
.tl-stack { display: flex; flex-direction: column; gap: 10px; }

/* 卡片是纸（非玻璃），transform 随便用；列内让位/进场都走 move */
.tlc-move { transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1); }
.tlc-enter-active { transition: opacity 0.2s ease, transform 0.2s ease; }
.tlc-enter-from { opacity: 0; transform: translateY(6px); }
.tlc-leave-active { display: none; }   /* 删除即消失，让位动画交给 move */

.tl-empty {
  align-self: flex-start;
  padding: 48px 24px; font-size: 12.5px; color: var(--text-secondary);
}
</style>
