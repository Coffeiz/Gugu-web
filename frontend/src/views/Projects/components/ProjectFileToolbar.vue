<template>
  <button class="col-toggle-btn" @click="togglePmStages"
    :title="stagesExpanded ? '恢复文件区' : '展开阶段区'">
    <PhCaretLeft v-if="stagesExpanded" :size="13" weight="bold" />
    <PhCaretRight v-else :size="13" weight="bold" />
  </button>

  <div class="right-header">
    <ProjectFileBreadcrumb
      :can-go-back="pmCanGoBack"
      :can-go-forward="pmCanGoForward"
      :drag-over-index="pmBcDragOverIdx"
      :folder-stack="folderStack"
      @go-back="pmGoBack"
      @go-forward="pmGoForward"
      @navigate="pmNavigateTo"
    />
    <FilePasteButton v-if="pmCbStore.hasContent()" compact
      :count="pmCbStore.fileIds.length + pmCbStore.folderIds.length" @paste="pmCtxPaste" />
    <button class="sel-mode-btn" :class="{ on: pmInSelectionMode }"
      @click.stop="togglePmSelectionMode" title="多选模式">
      <PhCheckSquare :size="13" weight="bold" />
    </button>
    <SegmentedControl class="view-toggle" :active-index="fileViewMode === 'grid' ? 0 : 1"
      style="--pill-bg: rgba(255,255,255,0.85); --pill-radius: 6px">
      <button :class="{ on: fileViewMode === 'grid' }" @click="fileViewMode = 'grid'" title="网格视图">
        <PhSquaresFour :size="13" weight="bold" />
      </button>
      <button :class="{ on: fileViewMode === 'list' }" @click="fileViewMode = 'list'" title="列表视图">
        <PhList :size="13" weight="bold" />
      </button>
    </SegmentedControl>
    <button v-if="!showNewFolder" class="new-folder-btn" @click.stop="showNewFolder = true">
      <PhFolderPlus :size="13" weight="bold" />新建文件夹
    </button>
    <div v-else class="new-folder-inline" @click.stop>
      <input class="new-folder-input" v-model="newFolderName" placeholder="文件夹名称"
        v-enter="createFolder" @keyup.esc="showNewFolder = false; newFolderName = ''"
        ref="folderInputRef" autofocus />
      <button class="btn-confirm-sm" :disabled="folderLoading" @click="createFolder">确定</button>
      <button class="btn-cancel-sm" @click="showNewFolder = false; newFolderName = ''">✕</button>
    </div>
    <SortMenu :options="PM_SORT_OPTIONS" :sort-key="pmSortKey" :sort-dir="pmSortDir" @select="onPmSortSelect" />
    <button class="close-btn" @click="closeProjectModal"><PhX :size="14" weight="bold" /></button>
  </div>
</template>

<script setup lang="ts">
import type { PropType } from 'vue'
import { PhCaretLeft, PhCaretRight, PhCheckSquare, PhFolderPlus, PhList, PhSquaresFour, PhX } from '@phosphor-icons/vue'
import SortMenu from '@/components/common/SortMenu.vue'
import FilePasteButton from '@/components/common/FilePasteButton.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import ProjectFileBreadcrumb from '@/views/Projects/components/ProjectFileBreadcrumb.vue'

const props = defineProps({ context: { type: Object as PropType<Record<string, any>>, required: true } })
const {
  stagesExpanded, togglePmStages, pmCanGoBack, pmGoBack, pmCanGoForward, pmGoForward,
  pmNavigateTo, folderStack, pmBcDragOverIdx, pmCbStore, pmCtxPaste, pmInSelectionMode,
  togglePmSelectionMode, fileViewMode, showNewFolder, newFolderName, folderLoading, createFolder,
  folderInputRef, PM_SORT_OPTIONS, pmSortKey, pmSortDir, onPmSortSelect, closeProjectModal,
} = props.context
</script>
