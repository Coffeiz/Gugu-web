<template>
  <FileBrowserGrid ref="browserRef" :class="{ 'is-virtual': virtualEnabled }" :style="gridStyle" :layout-collection="layoutCollection" @empty-context="openCtx('empty', null, $event)">
    <RuntimeFolderCard v-for="f in visibleFolders" :key="f.id"
      :card-props="{ displayName: f.displayName, countLabel: f.count != null ? t('filesViewUi.items', { count: f.count }) : '—', accentColor: folderAccentColor(f), selected: selectedFolderKeys.has(f.id), preSelected: previewFolderKeys.has(f.id), selectionMode: inSelectionMode }"
      :runtime-id="folderLayoutKey(f)" runtime-surface-id="files:surface:browser"
      :runtime-selected="selectedFolderKeys.has(f.id)"
      :runtime-abilities="f.type === 'folder' && f.folderId != null ? ['move'] : []"
      :runtime-target="f.type === 'folder' && f.folderId != null ? { surfaceId: `files:surface:folder:${f.folderId}`, accepts: ['file-item', 'folder-item'], priority: 2 } : undefined"
      :data-folder-key="f.id" :data-folder-id="f.folderId"
      data-layout-role="card" :data-layout-key="folderLayoutKey(f)"
      @contextmenu.prevent.stop="openCtx('folder', f, $event)" @click.stop="handleFolderClick(f, $event)">
      <template #icon><component :is="folderListIcon(f)" class="fd-big-icon" :size="92" /></template>
      <template #name><span :title="f.displayName"><RenameInput v-if="renamingFolderKey === f.folderId" v-model="renameText" @commit="commitRename" @cancel="cancelRename" /><template v-else>{{ f.displayName }}</template></span></template>
      <template v-if="f.type === 'folder' && f.folderId != null" #actions>
        <button class="file-card-btn" :title="renamingFolderKey === f.folderId ? t('sharedUi.confirm') : t('sharedUi.rename')" @pointerdown.stop @mousedown.prevent @click.stop="renamingFolderKey === f.folderId ? commitRename() : startRenameFolder(f)"><Icon name="status.success" v-if="renamingFolderKey === f.folderId" :size="11" /><Icon name="action.edit" v-else :size="11" /></button>
        <button class="file-card-btn" :title="t('sharedUi.downloadZip')" @pointerdown.stop @click.stop="downloadFolder(f)"><Icon name="action.download" :size="11" /></button>
        <button class="file-card-btn del" :title="t('sharedUi.delete')" @pointerdown.stop @click.stop="deleteFolder(f)"><Icon name="action.delete" :size="11" /></button>
      </template>
    </RuntimeFolderCard>

    <RuntimeFileCard v-for="f in visibleFiles" :key="f.id"
      :card-props="{ ext: f.ext, displayName: f.displayName, hasThumb: isImageExt(f.ext), selected: selectedIds.has(f.id), preSelected: previewFileIds.has(f.id), cut: cbStore.type === 'cut' && cbStore.fileIds.includes(f.id), selectionMode: inSelectionMode }"
      :runtime-id="fileLayoutKey(f)" runtime-surface-id="files:surface:browser"
      :runtime-selected="selectedIds.has(f.id)"
      :runtime-abilities="['move']"
      :data-file-id="f.id" data-layout-role="card" :data-layout-key="fileLayoutKey(f)" @contextmenu.prevent.stop="openCtx('file', f, $event)" @click.stop="handleFileClick(f, $event)">
      <template #thumb><img class="fc-thumb-tiny" v-lazy-src="{ id: f.id, size: 'tiny', revision: f.thumbRevision ?? f.version }" decoding="async" draggable="false" alt="" /><img class="fc-thumb-full" v-lazy-src="{ id: f.id, size: 'card', revision: f.thumbRevision ?? f.version }" :class="{ 'fc-loaded': cardBlobReadyIds.has(f.id) }" decoding="async" draggable="false" alt="" @load="cardBlobReadyIds.add(f.id)" @error="($event.target as HTMLElement).style.display='none'" /><div class="fc-thumb-fade"></div></template>
      <template #name><RenameInput v-if="renamingFileId === f.id" v-model="renameText" :extension="f.ext.toUpperCase() === 'FILE' || !f.displayName ? undefined : renameExtension" @update:extension="renameExtension = $event" :extension-required="f.ext.toUpperCase() !== 'FILE' && !!f.displayName" @commit="commitRename" @cancel="cancelRename" /><template v-else>{{ f.displayName }}</template></template>
      <template #meta>{{ fmtBytes(f.sizeBytes) }} · {{ formatFileCreatedDate(f.createdAt) }}</template>
      <div v-if="!inSelectionMode" class="fc-hover-actions"><button class="file-card-btn" :title="renamingFileId === f.id ? t('sharedUi.confirm') : t('sharedUi.rename')" @pointerdown.stop @mousedown.prevent @click.stop="renamingFileId === f.id ? commitRename() : startRenameFile(f)"><Icon name="status.success" v-if="renamingFileId === f.id" :size="11" /><Icon name="action.edit" v-else :size="11" /></button><button v-if="isExtractableArchive(f)" class="file-card-btn" :title="t('filesViewUi.extractTo')" @pointerdown.stop @click.stop="extractFile(f)"><Icon name="action.archive" :size="11" /></button><button class="file-card-btn" :title="t('sharedUi.download')" @pointerdown.stop @click.stop="downloadFile(f)"><Icon name="action.download" :size="11" /></button><button class="file-card-btn del" :title="t('sharedUi.moveToTrash')" @pointerdown.stop @click.stop="deleteSingleFile(f)"><Icon name="action.delete" :size="11" /></button></div>
    </RuntimeFileCard>
    <FileUploadGhostCard v-for="g in visibleUploads" :key="g.uid" :name="g.name" :ext="g.ext" :is-folder="g.isFolder" :progress="g.progress" :done="g.done" :total="g.total" :failed="g.failed" :error="g.error" :status-text="g.statusText" :indeterminate="g.indeterminate" data-flip-target />
    <FileUploadButton v-if="showUploadButton" mode="grid" data-flip-target @select="handleFileInput" />
  </FileBrowserGrid>
  <FileBrowserEmptyState
    v-if="contents.folders.length === 0 && contents.files.length === 0 && (loading || !canUpload)"
    variant="grid"
    :loading="loading"
    :text="loading ? t('common.status.loading') : undefined"
  />
</template>

<script setup lang="ts">
import Icon from '@/components/common/icons/Icon.vue'
import { computed, watch, type PropType } from 'vue'
import FileBrowserGrid from '@/components/common/file-browser/FileBrowserGrid.vue'
import FileBrowserEmptyState from '@/components/common/file-browser/FileBrowserEmptyState.vue'
import RuntimeFileCard from '@/components/common/file-browser/RuntimeFileCard.vue'
import RuntimeFolderCard from '@/components/common/file-browser/RuntimeFolderCard.vue'
import FileUploadButton from '@/components/common/file-browser/FileUploadButton.vue'
import FileUploadGhostCard from '@/components/common/file-browser/FileUploadGhostCard.vue'
import RenameInput from '@/components/common/file-browser/RenameInput.vue'
import { vLazyThumb as vLazySrc } from '@/composables/shared/useLazyThumb'
import { fmtBytes } from '@/utils/fileSize'
import { formatFileCreatedDate } from '@/utils/fileDate'
import { useI18n } from 'vue-i18n'
import { useFileBrowserWindow } from '@/composables/files/useFileBrowserWindow'
const props = defineProps({ context: { type: Object as PropType<Record<string, any>>, required: true } })
const { t } = useI18n()
const { contents, sortedContents, selectedFolderKeys, previewFolderKeys, inSelectionMode, openCtx, folderListIcon, folderAccentColor, handleFolderClick, renamingFolderKey, renameText, commitRename, cancelRename, startRenameFolder, downloadFolder, deleteFolder, selectedIds, previewFileIds, cbStore, handleFileClick, isImageExt, cardBlobReadyIds, renamingFileId, renameExtension, startRenameFile, downloadFile, deleteSingleFile, isExtractableArchive, extractFile, uploadingItems, canUpload, handleFileInput, loading, folderLayoutKey, fileLayoutKey, layoutCollection } = props.context
const { browserRef, visibleFolders, visibleFiles, gridStyle, tailStart, tailEnd, virtualEnabled } = useFileBrowserWindow(sortedContents, 'grid', {
  tailCount: () => uploadingItems.value.length + Number(canUpload.value),
  resetKey: () => props.context.directoryViewportKey.value,
})
const visibleUploads = computed(() => uploadingItems.value.slice(tailStart.value, tailEnd.value))
const showUploadButton = computed(() => canUpload.value && tailEnd.value > uploadingItems.value.length)
// 滚出窗口等同于离开编辑项，先保存，避免输入框卸载时取消延迟 blur 提交。
watch([visibleFolders, visibleFiles], () => {
  if (renamingFileId.value != null && !visibleFiles.value.some(file => file.id === renamingFileId.value)
    || renamingFolderKey.value != null && !visibleFolders.value.some(folder => folder.folderId === renamingFolderKey.value)) void commitRename()
})
</script>

<style scoped>
.file-browser-grid.file-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(158px,1fr)); gap:10px; align-content:start; }
.file-browser-grid.is-virtual :deep(.fc-card), .file-browser-grid.is-virtual :deep(.folder-card) { height:136px; box-sizing:border-box; }
.fc-hover-actions { position:absolute; top:8px; right:8px; display:flex; gap:3px; opacity:0; pointer-events:none; transition:opacity .15s; }
.fc-card:hover .fc-hover-actions { opacity:1; pointer-events:auto; }
.fc-thumb-tiny,.fc-thumb-full { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; }
.fc-thumb-tiny { filter:blur(10px); transform:scale(1.06); opacity:.7; }
.fc-thumb-full { opacity:0; transition:opacity .2s; }
.fc-thumb-full.fc-loaded { opacity:1; }
</style>
