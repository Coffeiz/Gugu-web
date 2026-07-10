<template>
  <div class="timeline">
    <div v-for="g in groups" :key="g.date" class="tl-group">
      <div class="tl-date">
        <span class="tl-date-main">{{ fmtDate(g.date) }}</span>
        <span class="tl-date-sub">{{ weekdayOf(g.date) }}</span>
        <span class="tl-count">{{ g.items.length }}</span>
      </div>

      <div v-for="n in g.items" :key="n.id" class="tl-note hover-card-fx"
           :class="{ editing: editingId === n.id }">
        <!-- 编辑态：同一个窄口径编辑器 -->
        <template v-if="editingId === n.id">
          <NoteEditor v-model="draft" autofocus @submit="commit(n)" />
          <div class="tl-edit-foot">
            <span v-if="conflict" class="tl-conflict">这条便签已被其他端改过，已刷新为最新内容</span>
            <button class="tl-btn" @click="cancel">取消</button>
            <button class="tl-btn primary" @click="commit(n)">保存</button>
          </div>
        </template>

        <!-- 只读态：轻量 HTML 预览（一条便签一个 TipTap 实例太重） -->
        <template v-else>
          <div class="tl-body md-preview" v-html="mdToPreviewHtml(n.contentMd)" @click="startEdit(n)"></div>
          <div class="tl-meta">
            <span class="tl-time">{{ fmtTime(n.capturedAt) }}</span>
            <button class="tl-icon" title="编辑" @click.stop="startEdit(n)">
              <PhPencilSimple :size="12" weight="bold" />
            </button>
            <button class="tl-icon danger" title="删除" @click.stop="emit('delete', n)">
              <PhTrash :size="12" weight="bold" />
            </button>
          </div>
        </template>
      </div>
    </div>

    <div v-if="!groups.length" class="tl-empty">还没有记录，上面写第一条吧～</div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { PhPencilSimple, PhTrash } from '@phosphor-icons/vue'
import { mdToPreviewHtml } from '@/composables/useMindEditor'
import type { MindNote } from '@/services/api'
import NoteEditor from './NoteEditor.vue'

defineProps<{ groups: { date: string; items: MindNote[] }[] }>()
const emit = defineEmits<{
  (e: 'save', note: MindNote, md: string): void
  (e: 'delete', note: MindNote): void
}>()

const editingId = ref<number | null>(null)
const draft     = ref('')
const conflict  = ref(false)

function startEdit(n: MindNote) {
  editingId.value = n.id
  draft.value = n.contentMd
  conflict.value = false
}
function cancel() { editingId.value = null; conflict.value = false }
function commit(n: MindNote) {
  if (draft.value !== n.contentMd) emit('save', n, draft.value)
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
function fmtTime(ts: string) { return ts.slice(11, 16) }

defineExpose({ flagConflict: () => { conflict.value = true } })
</script>

<style scoped>
.timeline { display: flex; flex-direction: column; gap: 18px; }

.tl-group { display: flex; flex-direction: column; gap: 8px; }
.tl-date { display: flex; align-items: baseline; gap: 8px; padding-left: 2px; }
.tl-date-main { font-size: 13px; font-weight: 700; color: var(--text-primary); }
.tl-date-sub  { font-size: 11px; color: var(--text-secondary); }
.tl-count {
  margin-left: auto; font-size: 10.5px; color: var(--text-secondary);
  background: rgba(123,127,178,0.1); border-radius: 99px; padding: 1px 7px;
}

.tl-note {
  position: relative;
  padding: 10px 13px; border-radius: 12px;
  background: rgba(255,255,255,0.66);
  border: 1px solid rgba(255,255,255,0.88);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 1px 4px rgba(80,90,110,0.05);
}
.tl-note.editing { background: rgba(255,255,255,0.9); cursor: default; }
.tl-note:not(.editing) .tl-body { cursor: text; }

.tl-meta {
  display: flex; align-items: center; gap: 4px;
  margin-top: 6px; opacity: 0; transition: opacity 0.15s;
}
.tl-note:hover .tl-meta { opacity: 1; }
.tl-time { font-size: 10.5px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.tl-icon {
  margin-left: 2px; padding: 3px; border: none; border-radius: 5px;
  background: transparent; color: var(--text-secondary); cursor: pointer;
  display: inline-flex; align-items: center;
}
.tl-icon:hover { background: rgba(123,127,178,0.12); color: var(--color-primary); }
.tl-icon.danger:hover { background: rgba(176,120,88,0.12); color: #b07858; }

.tl-edit-foot { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.tl-conflict { margin-right: auto; font-size: 11px; color: #b07858; }
.tl-btn {
  padding: 4px 12px; border-radius: 7px; cursor: pointer;
  border: 1px solid rgba(123,127,178,0.3); background: rgba(255,255,255,0.6);
  font-size: 12px; color: var(--text-secondary); font-family: var(--font-sans);
}
.tl-btn:first-of-type { margin-left: auto; }
.tl-btn.primary {
  border-color: transparent; color: #fff;
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
}

.tl-empty { padding: 40px 0; text-align: center; font-size: 12.5px; color: var(--text-secondary); }
</style>

<style>
/* v-html 出来的预览内容，不能 scoped */
.md-preview { font-size: 13.5px; line-height: 1.65; color: var(--text-primary); }
.md-preview p { margin: 0.25em 0; }
.md-preview h1 { font-size: 16px; font-weight: 700; margin: 0.3em 0 0.2em; }
.md-preview h2 { font-size: 14.5px; font-weight: 700; margin: 0.3em 0 0.2em; }
.md-preview h3 { font-size: 13.5px; font-weight: 600; margin: 0.3em 0 0.2em; }
.md-preview .np-tasks { list-style: none; padding: 0; margin: 0.3em 0; }
.md-preview .np-tasks li { display: flex; align-items: flex-start; gap: 8px; }
.md-preview .np-tasks li.done > span { opacity: 0.45; text-decoration: line-through; }
.md-preview .np-tasks input { margin-top: 3px; }
</style>
