<template>
  <button class="col-toggle-btn" @click="togglePmStages"
    :title="stagesExpanded ? '恢复文件区' : '展开阶段区'">
    <PhCaretLeft v-if="stagesExpanded" :size="13" weight="bold" />
    <PhCaretRight v-else :size="13" weight="bold" />
  </button>

  <FileBrowserToolbar
    :can-paste="pmCbStore.hasContent()"
    :paste-count="pmCbStore.fileIds.length + pmCbStore.folderIds.length"
    :selection-mode="pmInSelectionMode"
    :view-mode="fileViewMode"
    :show-new-folder="showNewFolder"
    :new-folder-name="newFolderName"
    :folder-loading="folderLoading"
    :sort-options="PM_SORT_OPTIONS"
    :sort-key="pmSortKey"
    :sort-dir="pmSortDir"
    @paste="pmCtxPaste"
    @toggle-selection="togglePmSelectionMode"
    @update:view-mode="value => fileViewMode = value"
    @update:show-new-folder="value => showNewFolder = value"
    @update:new-folder-name="value => newFolderName = value"
    @create-folder="createFolder"
    @sort-select="onPmSortSelect"
    @close="closeProjectModal"
  >
    <template #breadcrumb>
      <ProjectFileBreadcrumb
        :can-go-back="pmCanGoBack"
        :can-go-forward="pmCanGoForward"
        :drag-over-index="pmBcDragOverIdx"
        :folder-stack="folderStack"
        @go-back="pmGoBack"
        @go-forward="pmGoForward"
        @navigate="pmNavigateTo"
      />
    </template>
  </FileBrowserToolbar>
</template>

<script setup lang="ts">
import type { PropType } from 'vue'
import { PhCaretLeft, PhCaretRight } from '@phosphor-icons/vue'
import FileBrowserToolbar from '@/components/common/file-browser/FileBrowserToolbar.vue'
import ProjectFileBreadcrumb from '@/views/Projects/components/ProjectFileBreadcrumb.vue'

const props = defineProps({ context: { type: Object as PropType<Record<string, any>>, required: true } })
const {
  stagesExpanded, togglePmStages, pmCanGoBack, pmGoBack, pmCanGoForward, pmGoForward,
  pmNavigateTo, folderStack, pmBcDragOverIdx, pmCbStore, pmCtxPaste, pmInSelectionMode,
  togglePmSelectionMode, fileViewMode, showNewFolder, newFolderName, folderLoading, createFolder,
  PM_SORT_OPTIONS, pmSortKey, pmSortDir, onPmSortSelect, closeProjectModal,
} = props.context
</script>
