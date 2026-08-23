<template>
  <div class="file-browser-toolbar right-header">
    <GlassBg />
    <slot name="breadcrumb" />
    <FilePasteButton v-if="canPaste" compact :count="pasteCount" @paste="emit('paste')" />
    <button v-if="showSelection" class="sel-mode-btn select-mode-btn" :class="{ on: selectionMode }"
      @click.stop="emit('toggle-selection')" title="多选模式">
      <Icon name="status.check-square" :size="13" />
    </button>
    <SegmentedControl v-if="showViewToggle" class="view-toggle" :active-index="viewMode === 'grid' ? 0 : 1">
      <button :class="{ on: viewMode === 'grid' }" @click="emit('update:view-mode', 'grid')" title="网格视图">
        <Icon name="navigation.grid" :size="13" />
      </button>
      <button :class="{ on: viewMode === 'list' }" @click="emit('update:view-mode', 'list')" title="列表视图">
        <Icon name="navigation.list" :size="13" />
      </button>
    </SegmentedControl>
    <button v-if="showNewFolderButton && !showNewFolder" class="new-folder-btn" @click.stop="emit('update:show-new-folder', true)">
      <Icon name="file.folder-add" :size="13" />新建文件夹
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
    <button v-if="showClose" class="close-btn" @click="emit('close')"><Icon name="action.close" :size="14" /></button>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch, type PropType } from 'vue'
import Icon from '@/components/common/Icon.vue'
import SortMenu from '@/components/common/SortMenu.vue'
import FilePasteButton from '@/components/common/FilePasteButton.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import GlassBg from '@/components/common/GlassBg.vue'

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
/* 共享工具栏只负责内部布局。外框高度属于宿主：文件库保持 v0.20.4 的 52px，
   项目编辑卡在自己的 toolbar host 中声明同样的高度。control paint/尺寸继续由
   file-toolbar-theme-refinements.css 唯一负责。 */
.file-browser-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  position: relative;
  isolation: isolate;
  background: transparent;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
.new-folder-inline {
  display: flex;
  align-items: center;
  gap: 5px;
}
</style>
