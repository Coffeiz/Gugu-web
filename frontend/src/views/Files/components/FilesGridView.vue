<template>
  <FileBrowserGrid :layout-collection="layoutCollection" @empty-context="openCtx('empty', null, $event)">
    <RuntimeFolderCard v-for="f in sortedContents.folders" :key="f.id"
      :card-props="{ displayName: f.displayName, countLabel: f.count != null ? t('filesViewUi.items', { count: f.count }) : '—', accentColor: folderAccentColor(f), selected: selectedFolderKeys.has(f.id), preSelected: previewFolderKeys.has(f.id), selectionMode: inSelectionMode }"
      :runtime-id="folderLayoutKey(f)" runtime-surface-id="files:surface:browser"
      :runtime-selected="selectedFolderKeys.has(f.id)"
      :runtime-abilities="f.type === 'folder' && f.folderId != null ? ['move'] : []"
      :runtime-target="f.type === 'folder' && f.folderId != null ? { surfaceId: `files:surface:folder:${f.folderId}`, accepts: ['file-item', 'folder-item'], priority: 2 } : undefined"
      :data-folder-key="f.id" :data-folder-id="f.folderId"
      data-layout-role="card" :data-layout-key="folderLayoutKey(f)"
      @contextmenu.prevent.stop="openCtx('folder', f, $event)" @click.stop="handleFolderClick(f, $event)">
      <template #icon><component :is="folderListIcon(f)" class="fd-big-icon" :size="92" /></template>
      <template #name><span :title="f.displayName"><span v-if="renamingFolderKey === f.folderId" class="rename-sizer" @click.stop><span class="rename-ghost">{{ renameText || ' ' }}</span><input class="rename-input-inline" v-model="renameText" v-enter="commitRename" @keydown.esc="cancelRename" @blur="commitRename" @focus="($event.target as HTMLInputElement).select()" /></span><template v-else>{{ f.displayName }}</template></span></template>
      <template v-if="f.type === 'folder' && f.folderId != null" #actions>
        <button class="file-card-btn" :title="renamingFolderKey === f.folderId ? t('sharedUi.confirm') : t('sharedUi.rename')" @mousedown.prevent @click.stop="renamingFolderKey === f.folderId ? commitRename() : startRenameFolder(f)"><Icon name="status.success" v-if="renamingFolderKey === f.folderId" :size="11" /><Icon name="action.edit" v-else :size="11" /></button>
        <button class="file-card-btn" :title="t('sharedUi.downloadZip')" @click.stop="downloadFolder(f)"><Icon name="action.download" :size="11" /></button>
        <button class="file-card-btn del" :title="t('sharedUi.delete')" @click.stop="deleteFolder(f)"><Icon name="action.delete" :size="11" /></button>
      </template>
    </RuntimeFolderCard>

    <RuntimeFileCard v-for="f in sortedContents.files" :key="f.id" class="hover-card-fx"
      :card-props="{ ext: f.ext, displayName: f.displayName, hasThumb: isImageExt(f.ext), selected: selectedIds.has(f.id), preSelected: previewFileIds.has(f.id), cut: cbStore.type === 'cut' && cbStore.fileIds.includes(f.id), selectionMode: inSelectionMode }"
      :runtime-id="fileLayoutKey(f)" runtime-surface-id="files:surface:browser"
      :runtime-selected="selectedIds.has(f.id)"
      :runtime-abilities="['move']"
      :data-file-id="f.id" data-layout-role="card" :data-layout-key="fileLayoutKey(f)" @contextmenu.prevent.stop="openCtx('file', f, $event)" @click.stop="handleFileClick(f, $event)">
      <template #thumb><img class="fc-thumb-tiny" v-lazy-src="{ id: f.id, size: 'tiny', revision: f.thumbRevision }" decoding="async" draggable="false" alt="" /><img class="fc-thumb-full" v-lazy-src="{ id: f.id, size: 'card', revision: f.thumbRevision }" :class="{ 'fc-loaded': cardBlobReadyIds.has(f.id) }" decoding="async" draggable="false" alt="" @load="cardBlobReadyIds.add(f.id)" @error="($event.target as HTMLElement).style.display='none'" /><div class="fc-thumb-fade"></div></template>
      <template #name><span v-if="renamingFileId === f.id" class="rename-sizer" @click.stop><span class="rename-ghost">{{ renameText || ' ' }}</span><input class="rename-input-inline" v-model="renameText" v-enter="commitRename" @keydown.esc="cancelRename" @blur="commitRename" @focus="($event.target as HTMLInputElement).select()" /></span><template v-else>{{ f.displayName }}</template></template>
      <template #meta>{{ f.size }} · {{ f.createdAt }}</template>
      <div v-if="!inSelectionMode" class="fc-hover-actions"><button class="file-card-btn" :title="renamingFileId === f.id ? t('sharedUi.confirm') : t('sharedUi.rename')" @mousedown.prevent @click.stop="renamingFileId === f.id ? commitRename() : startRenameFile(f)"><Icon name="status.success" v-if="renamingFileId === f.id" :size="11" /><Icon name="action.edit" v-else :size="11" /></button><button class="file-card-btn" :title="t('sharedUi.download')" @click.stop="downloadFile(f)"><Icon name="action.download" :size="11" /></button><button class="file-card-btn del" :title="t('sharedUi.moveToTrash')" @click.stop="deleteSingleFile(f)"><Icon name="action.delete" :size="11" /></button></div>
    </RuntimeFileCard>
    <FileUploadGhostCard v-for="g in uploadingItems" :key="g.uid" :name="g.name" :ext="g.ext" :is-folder="g.isFolder" :progress="g.progress" :done="g.done" :total="g.total" :failed="g.failed" :error="g.error" data-flip-target />
    <FileUploadButton v-if="canUpload" mode="grid" data-flip-target @select="handleFileInput" />
  </FileBrowserGrid>
  <FileBrowserEmptyState v-if="contents.folders.length === 0 && contents.files.length === 0 && !loading && !canUpload" variant="grid" />
</template>

<script setup lang="ts">
import Icon from '@/components/common/icons/Icon.vue'
import type { PropType } from 'vue'
import FileBrowserGrid from '@/components/common/file-browser/FileBrowserGrid.vue'
import FileBrowserEmptyState from '@/components/common/file-browser/FileBrowserEmptyState.vue'
import RuntimeFileCard from '@/components/common/file-browser/RuntimeFileCard.vue'
import RuntimeFolderCard from '@/components/common/file-browser/RuntimeFolderCard.vue'
import FileUploadButton from '@/components/common/file-browser/FileUploadButton.vue'
import FileUploadGhostCard from '@/components/common/file-browser/FileUploadGhostCard.vue'
import { vLazyThumb as vLazySrc } from '@/composables/useLazyThumb'
import { useI18n } from 'vue-i18n'
const props = defineProps({ context: { type: Object as PropType<Record<string, any>>, required: true } })
const { t } = useI18n()
const { contents, sortedContents, selectedFolderKeys, previewFolderKeys, inSelectionMode, openCtx, folderListIcon, folderAccentColor, handleFolderClick, renamingFolderKey, renameText, commitRename, cancelRename, startRenameFolder, downloadFolder, deleteFolder, selectedIds, previewFileIds, cbStore, handleFileClick, isImageExt, cardBlobReadyIds, renamingFileId, startRenameFile, downloadFile, deleteSingleFile, uploadingItems, canUpload, handleFileInput, loading, folderLayoutKey, fileLayoutKey, layoutCollection } = props.context
</script>

<style scoped>
.file-browser-grid.file-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(158px,1fr)); gap:10px; align-content:start; }
.fc-hover-actions { position:absolute; right:8px; bottom:8px; display:flex; gap:3px; opacity:0; transition:opacity .15s; }
.fc-card:hover .fc-hover-actions { opacity:1; }
.fc-thumb-tiny,.fc-thumb-full { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; }
.fc-thumb-tiny { filter:blur(10px); transform:scale(1.06); opacity:.7; }
.fc-thumb-full { opacity:0; transition:opacity .2s; }
.fc-thumb-full.fc-loaded { opacity:1; }
</style>
