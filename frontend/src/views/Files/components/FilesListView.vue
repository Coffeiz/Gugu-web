<template>
  <FileBrowserList :layout-collection="layoutCollection" @empty-context="openCtx('empty', null, $event)">
    <!-- 表头 -->
    <div class="list-head">
      <span
        v-for="item in headers"
        :key="item.key"
        class="lh-sortable"
        :class="{ active: sortKey === item.key }"
        @click="onSortSelect(item.key)"
      >{{ item.label }}<svg
        v-if="item.key"
        class="lh-arrow"
        :class="{ desc: sortDir === 'desc' }"
        width="8" height="8" viewBox="0 0 10 10" fill="none"
        stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
      ><path d="M5 2v6M2 5l3-3 3 3"/></svg></span>
    </div>

    <RuntimeFolderListRow v-for="f in sortedContents.folders" :key="f.id" :item="f" :context="props.context" :runtime-id="folderLayoutKey(f)" runtime-surface-id="files:surface:browser" :runtime-selected="selectedFolderKeys.has(f.id)" :runtime-abilities="f.type === 'folder' && f.folderId != null ? ['move'] : []" :runtime-target="f.type === 'folder' && f.folderId != null ? { surfaceId: `files:surface:folder:${f.folderId}`, accepts: ['file-item', 'folder-item'], priority: 2 } : undefined" />
    <RuntimeFileListRow v-for="f in sortedContents.files" :key="f.id" :item="f" :context="props.context" :runtime-id="fileLayoutKey(f)" runtime-surface-id="files:surface:browser" :runtime-selected="selectedIds.has(f.id)" :runtime-abilities="['move']" />

    <!-- 上传中的幽灵卡片 -->
    <FileUploadGhostCard
      v-for="g in uploadingItems"
      :key="g.uid"
      mode="list"
      :name="g.name"
      :ext="g.ext"
      :is-folder="g.isFolder"
      :progress="g.progress"
      :done="g.done"
      :total="g.total"
      :failed="g.failed"
      :error="g.error"
      data-flip-target
    >
      <template #list="{ color, statusText }">
        <span class="lr-name-cell">
          <Icon name="file.folder" v-if="g.isFolder" class="lr-file-icon" :size="16" :style="{ color }" />
          <component v-else :is="fileListIcon(g.ext)" class="lr-file-icon" :size="16" :style="{ color }" />
          <span class="lr-filename">{{ g.name }}</span>
        </span>
        <span class="lr-type-cell">
          <span v-if="!g.isFolder" class="lr-ext" :style="{ color: fileIconColor(g.ext), background: fileIconColor(g.ext) + '18' }">{{ g.ext || '—' }}</span>
        </span>
        <span class="lr-text">—</span>
        <span class="lr-text">—</span>
        <span class="lr-text">{{ statusText }}</span>
        <span class="lr-actions" />
      </template>
    </FileUploadGhostCard>

    <FileBrowserEmptyState v-if="contents.folders.length === 0 && contents.files.length === 0 && !loading && !canUpload" variant="list" />
    <FileUploadButton v-if="canUpload" mode="list" data-flip-target @select="handleFileInput" />
  </FileBrowserList>
</template>
<script setup lang="ts">
import Icon from '@/components/common/icons/Icon.vue'
import type { PropType } from 'vue'
import FileBrowserList from '@/components/common/file-browser/FileBrowserList.vue'
import FileBrowserEmptyState from '@/components/common/file-browser/FileBrowserEmptyState.vue'
import FileUploadButton from '@/components/common/file-browser/FileUploadButton.vue'
import FileUploadGhostCard from '@/components/common/file-browser/FileUploadGhostCard.vue'
import RuntimeFolderListRow from '@/views/Files/components/RuntimeFolderListRow.vue'
import RuntimeFileListRow from '@/views/Files/components/RuntimeFileListRow.vue'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({ context: { type: Object as PropType<Record<string, any>>, required: true } })
const { t } = useI18n()

const headers = computed(() => [
  { key: 'name', label: t('filesViewUi.name') },
  { key: 'type', label: t('filesViewUi.type') },
  { key: 'stage', label: t('filesViewUi.projectStage') },
  { key: 'size', label: t('filesViewUi.size') },
  { key: 'createdAt', label: t('filesViewUi.date') },
  { key: '', label: '' },
])

const {
  contents, sortedContents, sortKey, sortDir, onSortSelect, openCtx,
  selectedFolderKeys, previewFolderKeys, handleFolderClick,
  folderListIcon, folderAccentColor, renamingFolderKey, renameText, commitRename, cancelRename,
  startRenameFolder, downloadFolder, deleteFolder, inSelectionMode,
  selectedIds, previewFileIds, cbStore, handleFileClick,
  fileListIcon, fileIconColor, renamingFileId, startRenameFile, downloadFile, deleteSingleFile,
  uploadingItems, loading, canUpload, handleFileInput,
  folderLayoutKey, fileLayoutKey, layoutCollection,
} = props.context
</script>
