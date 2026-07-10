<template>
  <div class="timeline">
    <div v-for="g in groups" :key="g.date" class="tl-group" :data-date="g.date">
      <div class="tl-date">
        <span class="tl-date-main">{{ fmtDate(g.date) }}</span>
        <span class="tl-date-sub">{{ weekdayOf(g.date) }}</span>
        <span class="tl-count">{{ g.items.length }}</span>
      </div>

      <!-- 日期组内双列（窄屏塌回单列，不跨天）。TransitionGroup 的 move 过渡兜住
           编辑卡跨两列展开时其余卡片的让位重排（卡片是纸、非玻璃，transform 随便用）。
           单日单条右格空着：规则稳定 > 局部满铺（2026-07-10 定）。 -->
      <TransitionGroup tag="div" class="tl-grid" name="tlc">
        <NoteCard
          v-for="n in g.items"
          :key="n.id"
          :note="n"
          :editing="editingId === n.id"
          :highlight="highlightId === n.id"
          :conflict="editingId === n.id && conflict"
          :class="{ 'tl-span': editingId === n.id }"
          @edit="startEdit(n)"
          @cancel="cancel"
          @save="md => commit(n, md)"
          @delete="emit('delete', n)"
          @toggle-task="idx => emit('toggleTask', n, idx)"
        />
      </TransitionGroup>
    </div>

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
.timeline { display: flex; flex-direction: column; gap: 16px; }

.tl-group { display: flex; flex-direction: column; gap: 8px; }
.tl-date { display: flex; align-items: baseline; gap: 8px; padding-left: 2px; }
.tl-date-main { font-size: 13px; font-weight: 700; color: var(--text-primary); }
.tl-date-sub  { font-size: 11px; color: var(--text-secondary); }
.tl-count {
  font-size: 10.5px; color: var(--text-secondary);
  background: rgba(123,127,178,0.1); border-radius: 99px; padding: 1px 7px;
}

.tl-grid {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px; align-items: start;
}
@media (max-width: 900px) {
  .tl-grid { grid-template-columns: minmax(0, 1fr); }
}
/* 编辑中的卡就地展开、跨满两列，其余卡由 TransitionGroup move 让位 */
.tl-span { grid-column: 1 / -1; }

.tlc-move { transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1); }
.tlc-enter-active { transition: opacity 0.2s ease, transform 0.2s ease; }
.tlc-enter-from { opacity: 0; transform: translateY(6px); }
.tlc-leave-active { display: none; }   /* 删除即消失，让位动画交给 move */

.tl-empty { padding: 48px 0; text-align: center; font-size: 12.5px; color: var(--text-secondary); }
</style>
