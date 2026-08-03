<template>
  <div class="file-browser-panel">
    <slot name="toolbar">
      <FileBrowserToolbar
        class="files-toolbar glass-card"
        @click.stop
        :can-paste="canPaste"
        :paste-count="pasteCount"
        :selection-mode="selectionMode"
        :show-selection="showSelection"
        :show-view-toggle="showViewToggle"
        :show-new-folder-button="showNewFolderButton"
        :show-sort="showSort"
        :view-mode="viewMode"
        :show-new-folder="showNewFolder"
        :new-folder-name="newFolderName"
        :folder-loading="folderLoading"
        :sort-options="sortOptions"
        :sort-key="sortKey"
        :sort-dir="sortDir"
        :show-close="showClose"
        @paste="$emit('paste')"
        @toggle-selection="$emit('toggle-selection')"
        @update:view-mode="$emit('update:view-mode', $event)"
        @update:show-new-folder="$emit('update:show-new-folder', $event)"
        @update:new-folder-name="$emit('update:new-folder-name', $event)"
        @create-folder="$emit('create-folder')"
        @sort-select="$emit('sort-select', $event)"
        @close="$emit('close')"
      >
        <template #breadcrumb><slot name="breadcrumb" /></template>
        <template #extra><slot name="toolbar-extra" /></template>
        <template #trailing><slot name="trailing" /></template>
      </FileBrowserToolbar>
    </slot>
    <slot />
  </div>
</template>

<script setup lang="ts">
import type { PropType } from 'vue'
import FileBrowserToolbar from '@/components/common/FileBrowserToolbar.vue'

defineProps({
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
  showClose: { type: Boolean, default: false },
})

defineEmits<{
  paste: []
  'toggle-selection': []
  'update:view-mode': [value: 'grid' | 'list']
  'update:show-new-folder': [value: boolean]
  'update:new-folder-name': [value: string]
  'create-folder': []
  'sort-select': [value: any]
  close: []
}>()
</script>

<style scoped>
.file-browser-panel {
  min-width: 0;
  min-height: 0;
}
</style>
