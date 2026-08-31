<template>
  <div ref="listRef" class="cd-list canvas-list">
    <div v-for="canvas in canvases" :key="canvas.id" class="canvas-item" :class="{ active: canvas.id === activeId }" :data-layout-key="`canvas-${canvas.id}`" @click="open(canvas.id)">
      <span v-if="editingId === canvas.id" class="rename-sizer" @click.stop>
        <span class="rename-ghost">{{ editingText || ' ' }}</span>
        <input
          v-model="editingText"
          class="rename-input-inline"
          v-enter="() => commitRename(canvas.id)"
          @keydown.esc="cancelRename"
          @blur="commitRename(canvas.id)"
          @focus="($event.target as HTMLInputElement).select()"
        />
      </span>
      <span v-else class="ci-title">{{ (localTitles.get(canvas.id) ?? canvas.title) || t('mindUi.unnamedCanvas') }}</span>
      <div class="ci-actions">
        <button :disabled="savingIds.has(canvas.id)" :title="editingId === canvas.id ? t('mindUi.confirm') : t('mindUi.rename')" class="ci-btn" @mousedown.prevent @click.stop="editingId === canvas.id ? commitRename(canvas.id) : startRename(canvas)">
          <Icon v-if="editingId === canvas.id" name="status.success" :size="11" />
          <Icon v-else name="action.edit" :size="11" />
        </button>
        <button :disabled="savingIds.has(canvas.id)" :title="t('mindUi.deleteCanvas')" class="ci-btn ci-delete" @click.stop="remove(canvas)"><Icon name="action.delete" :size="11" /></button>
      </div>
    </div>
    <button class="canvas-create-card" data-layout-key="canvas-create" @click="emit('create')"><Icon name="action.add" :size="14" />{{ t('mindUi.newCanvas') }}</button>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUpdate, onUpdated, ref, type PropType } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import type { MindCanvas } from '@/services/api'
import { createFlipTransaction, createLayoutItems } from '@/interaction/layout/flipCoordinator'
import { showAppError } from '@/composables/useAppToast'
import { confirmDialog } from '@/composables/useConfirmDialog'

const props = defineProps({
  canvases: { type: Array as PropType<MindCanvas[]>, required: true },
  activeId: { type: Number as PropType<number | null>, default: null },
  rename: { type: Function as PropType<(id: number, title: string) => Promise<unknown>>, required: true },
})
const emit = defineEmits<{ (e: 'create'): void; (e: 'open', id: number): void; (e: 'delete', canvas: MindCanvas): void }>()
const { t } = useI18n()
const listRef = ref<HTMLElement | null>(null)
const editingId = ref<number | null>(null)
const editingText = ref('')
const savingIds = ref(new Set<number>())
const localTitles = ref(new Map<number, string>())
let pendingLayout: ReturnType<typeof createFlipTransaction> | null = null
let pendingLayoutItems: ReturnType<typeof createLayoutItems> = []

onBeforeUpdate(() => {
  pendingLayout?.cancel()
  const root = listRef.value
  if (!root) return
  const elements = Array.from(root.querySelectorAll<HTMLElement>('.canvas-item, .canvas-create-card'))
  pendingLayoutItems = createLayoutItems(elements, 'card')
  if (!pendingLayoutItems.length) return
  pendingLayout = createFlipTransaction({ duration: 280, easing: 'cubic-bezier(.22,1,.36,1)' })
  pendingLayout.capture(pendingLayoutItems)
})

onUpdated(() => {
  if (!pendingLayout || !pendingLayoutItems.length) return
  pendingLayout.measure(pendingLayoutItems)
  void pendingLayout.play()
  pendingLayout = null
})

function open(id: number) { emit('open', id) }
async function remove(canvas: MindCanvas) { if (await confirmDialog({ title: t('mindUi.deleteCanvas'), message: t('mindUi.deleteCanvasMessage', { name: canvas.title || t('mindUi.unnamedCanvas') }), tone: 'danger', confirmText: t('mindUi.deleteCanvas') })) emit('delete', canvas) }
function startRename(canvas: MindCanvas) {
  if (savingIds.value.has(canvas.id)) return
  editingId.value = canvas.id
  editingText.value = localTitles.value.get(canvas.id) ?? canvas.title ?? ''
  // 不用模板 ref：这个 input 嵌在 v-for 里，即使 v-if 保证同时只渲染一个，Vue 仍会把
  // 同名 ref 收集成数组（renameInput.value 变成 [HTMLInputElement]，数组没有 .focus()，
  // 表现为 TypeError）。改用 querySelector，跟 Files/index.vue 同款重命名输入框的
  // 现成写法一致，绕开这个 v-for + ref 的坑。
  nextTick(() => {
    const input = listRef.value?.querySelector<HTMLInputElement>('.rename-input-inline')
    input?.focus()
    input?.select()
  })
}
function cancelRename() { editingId.value = null; editingText.value = '' }
async function commitRename(id: number) {
  if (editingId.value !== id || savingIds.value.has(id)) return
  const title = editingText.value.trim()
  if (!title) return cancelRename()
  const previous = props.canvases.find(canvas => canvas.id === id)?.title ?? ''
  const next = new Set(savingIds.value)
  next.add(id)
  savingIds.value = next
  if (editingId.value === id) {
    editingId.value = null
    editingText.value = ''
  }
  localTitles.value.set(id, title)
  try {
    await props.rename(id, title)
    localTitles.value.delete(id)
  } catch {
    localTitles.value.delete(id)
    showAppError(t('mindUi.renameCanvasFailed', { name: previous || t('mindUi.unnamedCanvas') }))
  } finally {
    const remaining = new Set(savingIds.value)
    remaining.delete(id)
    savingIds.value = remaining
    if (editingId.value === id) {
      editingId.value = null
      editingText.value = ''
    }
  }
}
defineExpose({ listRef })
</script>

<style scoped>
/* .rename-sizer/.rename-ghost/.rename-input-inline 用 global.css 全站共用的那份
   （宽度随文字自适应），这里不再重新定义一套固定宽度的输入框——之前各画各的，
   跟文件库/项目卡的重命名输入框手感对不上（2026-07-17 复现：画布重命名样式跟别处不一致）。 */
.cd-list { box-sizing: border-box; padding: 0 9px 9px; }
.canvas-list { width: 190px; }
.canvas-item { display: flex; align-items: center; gap: 6px; width: 100%; box-sizing: border-box; height: 32px; padding: 0 4px 0 8px; border-radius: 6px; background: none; color: var(--text-secondary); font-size: 12px; cursor: pointer; }
.canvas-item:hover { background: var(--sidebar-item-hover); }
.canvas-item.active { background: var(--sidebar-item-active); color: var(--sidebar-item-active-fg); font-weight: 700; box-shadow: var(--elevation-card); }
.ci-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* global.css 里 .rename-sizer 是 inline-block，宽度随文字内容收缩——在这个 flex 行里
   会导致输入框跟着文字宽度走，右边的操作按钮跟着一起挪动、不再固定在行尾。这里改成
   flex:1 顶开剩余空间，行为对齐 .ci-title（2026-07-17 复现：进入重命名后图标跟着文字跑）。
   .rename-input-inline 本身不再本地覆盖，直接用 global.css 那份文件卡同款样式。 */
.canvas-item .rename-sizer { flex: 1; min-width: 0; }
.ci-actions { display: flex; flex-shrink: 0; gap: 2px; opacity: 0; transition: opacity .15s; }
.canvas-item:hover .ci-actions { opacity: 1; }
.canvas-item:has(.rename-sizer) .ci-actions { opacity: 1; }
.ci-btn { display: inline-flex; align-items: center; justify-content: center; width: 19px; height: 19px; border: 0; border-radius: 5px; background: none; color: var(--text-secondary); cursor: pointer; }
.ci-btn:hover { background: var(--action-soft-hover); color: var(--action-primary); }
.ci-delete:hover { background: var(--status-danger-bg); color: var(--status-danger); }
.canvas-create-card { display: flex; align-items: center; justify-content: center; gap: 5px; width: 100%; height: 32px; margin-top: 5px; box-sizing: border-box; border: 1.5px dashed var(--border-subtle); border-radius: 6px; background: var(--surface-soft); color: var(--text-secondary); font: 600 12px var(--font-sans); cursor: pointer; transition: background .15s ease, border-color .15s ease, color .15s ease; }
.canvas-create-card:hover { background: var(--action-soft); border-color: var(--action-outline); color: var(--action-primary); }
</style>
