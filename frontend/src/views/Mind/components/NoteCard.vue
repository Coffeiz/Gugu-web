<template>
  <div class="note-card" :class="{ editing, highlight, ['tint-' + (note.color || '')]: !!note.color }">
    <!-- 编辑态：就地展开（跨两列由父级 grid-column 控制），同一个窄口径编辑器 -->
    <template v-if="editing">
      <NoteEditor v-model="draft" autofocus @submit="commit" />
      <div class="nc-edit-foot">
        <span v-if="conflict" class="nc-conflict">这条便签已被其他端改过，已刷新为最新内容</span>
        <button class="nc-btn" @click="emit('cancel')">取消</button>
        <button class="nc-btn primary" @click="commit">保存</button>
      </div>
    </template>

    <!-- 只读态：顶部直接显示标题（由正文首行推导，#2），不再放日期/时间；hover 出编辑/删除 -->
    <template v-else>
      <div class="nc-head">
        <span class="nc-title" @click="emit('edit')">{{ title }}</span>
        <span class="nc-actions">
          <button class="nc-icon" title="编辑" @click.stop="emit('edit')">
            <PhPencilSimple :size="12" weight="bold" />
          </button>
          <button class="nc-icon danger" title="删除" @click.stop="emit('delete')">
            <PhTrash :size="12" weight="bold" />
          </button>
        </span>
      </div>
      <div v-if="bodyMd" ref="bodyRef" class="nc-body md-preview" :class="{ clamped: clamped && !expanded }"
           @click="onBodyClick" v-html="mdToPreviewHtml(bodyMd)"></div>
      <button v-if="clamped" class="nc-expand" @click.stop="expanded = !expanded">
        {{ expanded ? '收起' : '展开' }}
      </button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { PhPencilSimple, PhTrash } from '@phosphor-icons/vue'
import { mdToPreviewHtml } from '@/composables/useMindEditor'
import type { MindNote } from '@/services/api'
import NoteEditor from './NoteEditor.vue'

const props = defineProps<{
  note: MindNote
  editing: boolean
  highlight: boolean
  conflict: boolean
}>()

const emit = defineEmits<{
  (e: 'edit'): void
  (e: 'cancel'): void
  (e: 'save', md: string): void
  (e: 'delete'): void
  (e: 'toggle-task', idx: number): void
}>()

const draft    = ref('')
const expanded = ref(false)
const clamped  = ref(false)
const bodyRef  = ref<HTMLElement | null>(null)

// 进入编辑时灌当前内容为草稿；退出编辑复位
watch(() => props.editing, v => { if (v) draft.value = props.note.contentMd })

function commit() {
  if (draft.value !== props.note.contentMd) emit('save', draft.value)
  else emit('cancel')
}

/** 标题由正文首行推导（设计草案：卡片标题从正文标题块/首行推导），正文取其余行。
 *  首行剥掉 markdown 前缀（#/- [ ]/-），引用锚点只留显示名。首行为空则给占位。 */
const _split = computed(() => {
  const lines = (props.note.contentMd || '').split('\n')
  const ti = lines.findIndex(l => l.trim())
  if (ti < 0) return { title: '（空便签）', body: '', taskOffset: 0 }
  const titleLine = lines[ti].trim()
  const raw = titleLine
    .replace(/^#{1,6}\s+/, '')
    .replace(/^-\s\[[ xX]\]\s?/, '')
    .replace(/^-\s+/, '')
    .replace(/\[\[[a-z_]+:\d+\|([^\]]*)\]\]/g, '$1')
  const body = lines.slice(ti + 1).join('\n').replace(/^\n+/, '')
  // 标题行若本身是待办，被摘走后 body 里的待办序号整体前移 1，卡上勾选要补回这个偏移
  const taskOffset = /^-\s\[[ xX]\]/.test(titleLine) ? 1 : 0
  return { title: raw || '（无标题）', body, taskOffset }
})
const title  = computed(() => _split.value.title)
const bodyMd = computed(() => _split.value.body)

/** 是否溢出 clamp 高度（内容/展开态变了都重测）。scrollHeight 对比要在未展开的 clamp 态量 */
async function measureClamp() {
  await nextTick()
  const el = bodyRef.value
  if (!el) return
  if (expanded.value) return   // 展开着就保持"可收起"，不重判
  clamped.value = el.scrollHeight > el.clientHeight + 2
}
onMounted(measureClamp)
watch(() => props.note.contentMd, () => { expanded.value = false; measureClamp() })

/** 卡上直接勾待办：点击落在预览里的 checkbox 时翻转对应任务，不进编辑态 */
function onBodyClick(e: MouseEvent) {
  const t = e.target as HTMLElement
  if (t instanceof HTMLInputElement && t.dataset.taskIdx !== undefined) {
    e.preventDefault()   // 视觉状态由 PATCH 成功后的数据回流驱动，别让浏览器先勾上
    // body 里的待办序号 + 标题行占的偏移 = 完整 content 里的真实序号
    emit('toggle-task', Number(t.dataset.taskIdx) + _split.value.taskOffset)
    return
  }
  // 点引用 chip 不进编辑（将来跳对应对象页）；点其他区域进编辑
  if (t.closest('.mind-ref')) return
  emit('edit')
}
</script>

<style scoped>
/* 便签卡：与定时任务卡/项目卡同款质感（白 56% 底 + 白描边 + 顶部高光 ::after + hover
   加深阴影），躺在每日玻璃底板之内。卡自身不用 backdrop-filter（底板已经是玻璃），
   卡内 hover/让位动画都发生在底板内容层，不碰底板的 backdrop。 */
.note-card {
  position: relative;
  padding: 11px 13px;
  border-radius: var(--radius-md);
  background: rgba(255,255,255,0.56);
  border: 1px solid rgba(255,255,255,0.72);
  box-shadow: 0 2px 8px rgba(80,90,110,0.07);
  min-width: 0; overflow: hidden;
  transition: box-shadow 0.3s ease, background 0.25s ease-out;
}
/* 顶部高光层（task-card 同款）：hover 时整层提亮 */
.note-card::after {
  content: ''; position: absolute; inset: 0; border-radius: inherit;
  background: linear-gradient(to top, rgba(255,255,255,0.08), transparent 50%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9);
  transition: background 0.3s cubic-bezier(0.34,1.2,0.64,1); pointer-events: none;
}
.note-card > * { position: relative; z-index: 1; }
.note-card:not(.editing):hover { box-shadow: 0 6px 18px rgba(80,90,110,0.13); }
.note-card:not(.editing):hover::after { background: rgba(255,255,255,0.2); }

.note-card.editing { background: rgba(255,255,255,0.9); }
/* 窄列里就地编辑：工具栏放不下「输入 @ 引用…」提示文字，藏掉（捕捉条那份还在） */
.note-card.editing :deep(.ne-hint) { display: none; }

/* 新建高亮：紫灰 tint 淡出（提交滚回最左后让新卡自己说"我在这") */
.note-card.highlight { animation: nc-flash 1.6s ease-out; }
@keyframes nc-flash {
  0% { background-color: rgba(123,127,178,0.2); }
  100% { background-color: rgba(255,255,255,0.56); }
}

/* 可选低饱和颜色：整卡淡染（便签纸语言），不做左侧色条（那是管理系统语言） */
.note-card.tint-purple { background: rgba(123,127,178,0.14); }
.note-card.tint-pink   { background: rgba(196,175,200,0.18); }
.note-card.tint-cyan   { background: rgba(122,184,200,0.15); }
.note-card.tint-amber  { background: rgba(212,178,112,0.16); }

.nc-head {
  display: flex; align-items: flex-start; gap: 6px;
  margin-bottom: 4px; position: relative; z-index: 1;
}
.nc-title {
  flex: 1; min-width: 0; cursor: text;
  font-size: 14px; font-weight: 600; line-height: 1.35; color: var(--text-primary);
  overflow-wrap: anywhere;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
}
.nc-actions { margin-left: auto; flex-shrink: 0; display: flex; gap: 2px; opacity: 0; transition: opacity 0.15s; }
.note-card:hover .nc-actions { opacity: 1; }
.nc-icon {
  padding: 3px; border: none; border-radius: 5px;
  background: transparent; color: var(--text-secondary); cursor: pointer;
  display: inline-flex; align-items: center;
}
.nc-icon:hover { background: rgba(123,127,178,0.12); color: var(--color-primary); }
.nc-icon.danger:hover { background: rgba(176,120,88,0.12); color: #b07858; }

/* min-height 让短便签也有几行留白、卡片偏方形——一行字的扁条卡在 292px 列里太寒酸；
   overflow-wrap 治连续长串（纯数字/URL）不换行撑破卡片 */
.nc-body {
  position: relative; z-index: 1; cursor: text;
  min-height: 76px;
  overflow-wrap: anywhere;
}
.nc-body.clamped {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 6;
  overflow: hidden;
}
.nc-expand {
  margin-top: 4px; padding: 0; border: none; background: none;
  font-size: 11px; color: var(--color-primary); cursor: pointer;
  font-family: var(--font-sans); position: relative; z-index: 1;
}

.nc-edit-foot { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.nc-conflict { margin-right: auto; font-size: 11px; color: #b07858; }
.nc-btn {
  padding: 4px 12px; border-radius: 7px; cursor: pointer;
  border: 1px solid rgba(123,127,178,0.3); background: rgba(255,255,255,0.6);
  font-size: 12px; color: var(--text-secondary); font-family: var(--font-sans);
}
.nc-btn:first-of-type { margin-left: auto; }
.nc-btn.primary {
  border-color: transparent; color: #fff;
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
}
</style>

<style>
/* v-html 出来的预览内容，不能 scoped */
.md-preview { font-size: 13px; line-height: 1.6; color: var(--text-primary); }
.md-preview p { margin: 0.2em 0; }
.md-preview h1 { font-size: 15px; font-weight: 700; margin: 0.25em 0 0.15em; }
.md-preview .np-tasks { list-style: none; padding: 0; margin: 0.25em 0; }
.md-preview .np-tasks li { display: flex; align-items: flex-start; gap: 8px; }
.md-preview .np-tasks li.done > span { opacity: 0.45; text-decoration: line-through; }
.md-preview .np-tasks input { margin-top: 3px; cursor: pointer; }
.md-preview .np-list { padding-left: 1.2em; margin: 0.25em 0; }
.md-preview .np-list li { margin: 0.1em 0; }
</style>
