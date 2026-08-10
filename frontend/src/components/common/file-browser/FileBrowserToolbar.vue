<template>
  <div class="file-browser-toolbar right-header">
    <slot name="breadcrumb" />
    <FilePasteButton v-if="canPaste" compact :count="pasteCount" @paste="emit('paste')" />
    <button v-if="showSelection" class="sel-mode-btn select-mode-btn" :class="{ on: selectionMode }"
      @click.stop="emit('toggle-selection')" title="多选模式">
      <PhCheckSquare :size="13" weight="bold" />
    </button>
    <SegmentedControl v-if="showViewToggle" class="view-toggle" :active-index="viewMode === 'grid' ? 0 : 1"
      style="--pill-bg: rgba(255,255,255,0.85); --pill-radius: 6px">
      <button :class="{ on: viewMode === 'grid' }" @click="emit('update:view-mode', 'grid')" title="网格视图">
        <PhSquaresFour :size="13" weight="bold" />
      </button>
      <button :class="{ on: viewMode === 'list' }" @click="emit('update:view-mode', 'list')" title="列表视图">
        <PhList :size="13" weight="bold" />
      </button>
    </SegmentedControl>
    <button v-if="showNewFolderButton && !showNewFolder" class="new-folder-btn" @click.stop="emit('update:show-new-folder', true)">
      <PhFolderPlus :size="13" weight="bold" />新建文件夹
    </button>
    <div v-else-if="showNewFolderButton" class="new-folder-inline" @click.stop>
      <input ref="folderInput" class="new-folder-input" :value="newFolderName" placeholder="文件夹名称"
        @input="emit('update:new-folder-name', ($event.target as HTMLInputElement).value)"
        @keydown.enter="emit('create-folder')" @keyup.esc="cancelFolder" autofocus />
      <button class="btn-confirm-sm" :disabled="folderLoading" @click="emit('create-folder')">确定</button>
      <button class="btn-cancel-sm" @click="cancelFolder">✕</button>
    </div>
    <SortMenu v-if="showSort" :options="sortOptions" :sort-key="sortKey" :sort-dir="sortDir" @select="emit('sort-select', $event)" />
    <slot name="extra" />
    <slot name="trailing" />
    <button v-if="showClose" class="close-btn" @click="emit('close')"><PhX :size="14" weight="bold" /></button>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch, type PropType } from 'vue'
import { PhCheckSquare, PhFolderPlus, PhList, PhSquaresFour, PhX } from '@phosphor-icons/vue'
import SortMenu from '@/components/common/SortMenu.vue'
import FilePasteButton from '@/components/common/FilePasteButton.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'

const props = defineProps({
  canPaste: Boolean,
  pasteCount: { type: Number, default: 0 },
  selectionMode: Boolean,
  showSelection: { type: Boolean, default: true },
  showViewToggle: { type: Boolean, default: true },
  showNewFolderButton: { type: Boolean, default: true },
  showSort: { type: Boolean, default: true },
  viewMode: { type: String as PropType<'grid' | 'list'>, default: 'grid' },
  showNewFolder: Boolean,
  newFolderName: { type: String, default: '' },
  folderLoading: Boolean,
  sortOptions: { type: Array as PropType<any[]>, default: () => [] },
  sortKey: { type: String, default: 'name' },
  sortDir: { type: String as PropType<'asc' | 'desc'>, default: 'asc' },
  showClose: { type: Boolean, default: true },
})
const emit = defineEmits<{
  paste: []
  'toggle-selection': []
  'update:view-mode': [value: 'grid' | 'list']
  'update:show-new-folder': [value: boolean]
  'update:new-folder-name': [value: string]
  'create-folder': []
  'sort-select': [value: any]
  close: []
}>()
const folderInput = ref<HTMLInputElement | null>(null)
function cancelFolder() {
  emit('update:show-new-folder', false)
  emit('update:new-folder-name', '')
}
// Vue 的 autofocus 在已挂载的弹窗中不一定触发，显式聚焦保证键盘输入行为稳定。
watch(() => props.showNewFolder, value => {
  if (value) nextTick(() => folderInput.value?.focus())
})
</script>

<style scoped>
.file-browser-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.sel-mode-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: rgba(255,255,255,.58);
  color: var(--text-secondary);
  cursor: pointer;
}
.sel-mode-btn.on { color: var(--color-primary); background: rgba(123,127,178,.14); }
.sel-mode-btn:hover { color: var(--text-primary); background: rgba(0,0,0,.06); }
.new-folder-inline { display: flex; align-items: center; gap: 5px; }
.new-folder-inline .new-folder-input { width: 120px; }
.btn-confirm-sm, .btn-cancel-sm {
  border: none;
  border-radius: 6px;
  padding: 4px 7px;
  font-size: 11px;
  cursor: pointer;
}
.btn-confirm-sm { background: var(--color-primary); color: #fff; }
.btn-confirm-sm:disabled { opacity: .5; cursor: default; }
.btn-cancel-sm {
  background: rgba(0,0,0,.07); color: var(--text-secondary);
  width: 28px; height: 28px; padding: 0; border: none;
  display: inline-flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
</style>
