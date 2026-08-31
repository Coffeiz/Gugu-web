<template>
  <div ref="listRef" class="cd-list canvas-list" data-layout-collection="mind:drawer:canvases">
    <div v-for="canvas in canvases" :key="canvas.id" class="canvas-item" :class="{ active: canvas.id === activeId, selected: selectedIds.has(canvas.id) }" data-layout-role="card" data-layout-group="mind:drawer:canvases" :data-layout-key="`canvas-${canvas.id}`" @click="open(canvas.id)">
      <button type="button" class="ci-select" :aria-label="selectedIds.has(canvas.id) ? t('mindUi.clearSelection') : t('mindUi.selectCanvas')" @click.stop="toggleSelected(canvas.id)"><Icon v-if="selectedIds.has(canvas.id)" name="status.success" :size="11" /></button>
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
    <div class="canvas-drawer-footer">
      <button class="canvas-create-card" data-layout-role="card" data-layout-group="mind:drawer:canvases" data-layout-key="canvas-create" @click="onCreate"><Icon name="action.add" :size="14" />{{ t('mindUi.newCanvas') }}</button>
      <div v-if="selectedIds.size" class="canvas-selection-actions">
        <button type="button" class="ci-batch-delete" @click="removeSelected"><Icon name="action.delete" :size="12" />{{ t('common.actions.delete') }}</button>
        <button type="button" class="ci-clear-selection" @click="clearSelection">{{ t('common.actions.clearSelection') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUpdate, onUpdated, ref, watch, type PropType } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import type { MindCanvas } from '@/services/api'
import { createFlipTransaction, createLayoutItems } from '@/interaction/layout/flipCoordinator'
import { runtime } from '@/interaction/runtime'
import { showAppError } from '@/composables/useAppToast'
import { confirmDialog } from '@/composables/useConfirmDialog'

const props = defineProps({
  canvases: { type: Array as PropType<MindCanvas[]>, required: true },
  activeId: { type: Number as PropType<number | null>, default: null },
  rename: { type: Function as PropType<(id: number, title: string) => Promise<unknown>>, required: true },
})
const emit = defineEmits<{ (e: 'create'): void; (e: 'open', id: number): void; (e: 'delete', canvas: MindCanvas): void; (e: 'deleteMany', ids: number[]): void }>()
const { t } = useI18n()
const listRef = ref<HTMLElement | null>(null)
const editingId = ref<number | null>(null)
const editingText = ref('')
const savingIds = ref(new Set<number>())
const localTitles = ref(new Map<number, string>())
const selectedIds = ref(new Set<number>())
watch(() => props.canvases, canvases => {
  const validIds = new Set(canvases.map(canvas => canvas.id))
  selectedIds.value = new Set([...selectedIds.value].filter(id => validIds.has(id)))
})
let pendingLayout: ReturnType<typeof createFlipTransaction> | null = null
let pendingLayoutItems: ReturnType<typeof createLayoutItems> = []
let lastLayoutSignature = props.canvases.map(canvas => canvas.id).join('|')

onBeforeUpdate(() => {
  const layoutSignature = props.canvases.map(canvas => canvas.id).join('|')
  const layoutChanged = layoutSignature !== lastLayoutSignature
  pendingLayout?.cancel()
  pendingLayout = null
  pendingLayoutItems = []
  if (!layoutChanged) return
  lastLayoutSignature = layoutSignature
  const root = listRef.value
  if (!root) return
  // 新建按钮位于 sticky footer，会随抽屉高度自然定位；如果也参与卡片 FLIP，
  // 删除时会同时叠加 transform 和 viewport height 两套位移，造成按钮抽动。
  const elements = Array.from(root.querySelectorAll<HTMLElement>('.canvas-item'))
  pendingLayoutItems = createLayoutItems(elements, 'card')
  if (!pendingLayoutItems.length) return
  const flipProfile = runtime.getMotionProfile()?.flip
  pendingLayout = createFlipTransaction({
    // 与画布抽屉 viewport 的 resize 事务保持同一时长，避免卡片先结束后
    // 继续被外层的垂直居中高度过渡带动，收尾时出现 1px 的二次移动。
    duration: flipProfile?.duration ?? 350,
    easing: flipProfile?.easing ?? 'cubic-bezier(.22,1,.36,1)',
  })
  pendingLayout.capture(pendingLayoutItems)
})

onUpdated(() => {
  if (!pendingLayout || !pendingLayoutItems.length) return
  pendingLayout.measure(pendingLayoutItems)
  void pendingLayout.play()
  pendingLayout = null
})

function open(id: number) { emit('open', id) }
function toggleSelected(id: number) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}
function clearSelection() { selectedIds.value = new Set() }
async function remove(canvas: MindCanvas) {
  if (selectedIds.value.has(canvas.id) && selectedIds.value.size > 1) return removeSelected()
  if (await confirmDialog({ title: t('mindUi.deleteCanvas'), message: t('mindUi.deleteCanvasMessage', { name: canvas.title || t('mindUi.unnamedCanvas') }), tone: 'danger', confirmText: t('mindUi.deleteCanvas') })) {
    const next = new Set(selectedIds.value)
    next.delete(canvas.id)
    selectedIds.value = next
    emit('delete', canvas)
  }
}
async function removeSelected() {
  const ids = [...selectedIds.value].filter(id => props.canvases.some(canvas => canvas.id === id))
  if (!ids.length) return clearSelection()
  if (!await confirmDialog({ title: t('mindUi.deleteSelectedCanvases'), message: t('mindUi.deleteSelectedCanvasesMessage', { count: ids.length }), tone: 'danger', confirmText: t('mindUi.deleteSelectedCanvases') })) return
  clearSelection()
  emit('deleteMany', ids)
}
function onCreate() {
  emit('create')
}
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
.ci-select { width: 16px; height: 16px; flex: 0 0 auto; display: grid; place-items: center; border: 1px solid var(--action-outline); border-radius: 4px; background: var(--control-bg); color: var(--content-secondary); cursor: pointer; transition: background .15s ease, border-color .15s ease, color .15s ease; }
.canvas-item.selected .ci-select { border-color: var(--action-primary); background: var(--action-primary); color: var(--content-on-accent); }
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
.canvas-drawer-footer { position: sticky; bottom: 0; z-index: 2; width: 100%; padding: 6px 0 9px; }
.canvas-selection-actions { display: flex; align-items: center; width: 100%; gap: 6px; padding: 7px 4px 0; }
.ci-batch-delete, .ci-clear-selection { display: inline-flex; align-items: center; justify-content: center; flex: 1 1 0; gap: 4px; min-height: 26px; padding: 4px 9px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); font: 600 11px var(--font-sans); cursor: pointer; transition: background .15s ease, border-color .15s ease, color .15s ease; }
.ci-batch-delete { color: var(--status-danger); background: var(--status-danger-bg); border-color: color-mix(in srgb, var(--status-danger) 30%, var(--border-subtle)); }
.ci-batch-delete:hover { background: color-mix(in srgb, var(--status-danger) 14%, var(--surface-soft)); border-color: var(--status-danger); }
.ci-clear-selection { color: var(--content-secondary); background: var(--surface-soft); }
.ci-clear-selection:hover { color: var(--content-primary); background: var(--action-soft-hover); border-color: var(--action-outline); }
.canvas-create-card { display: flex; align-items: center; justify-content: center; gap: 5px; width: 100%; height: 32px; margin-top: 5px; box-sizing: border-box; border: 1.5px dashed var(--border-subtle); border-radius: 6px; background: var(--surface-soft); color: var(--text-secondary); font: 600 12px var(--font-sans); cursor: pointer; transition: background .15s ease, border-color .15s ease, color .15s ease; }
.canvas-create-card:hover { background: var(--action-soft); border-color: var(--action-outline); color: var(--action-primary); }
</style>
