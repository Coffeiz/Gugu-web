<template>
  <FileBrowserGrid :layout-collection="layoutCollection" @empty-context="openCtx('empty', null, $event)">
    <RuntimeFolderCard v-for="f in sortedContents.folders" :key="f.id"
      :card-props="{ displayName: f.displayName, countLabel: f.count != null ? f.count + ' 项' : '—', accentColor: folderAccentColor(f), selected: selectedFolderKeys.has(f.id), preSelected: previewFolderKeys.has(f.id), dragOver: dragOverFolderId === f.folderId, selectionMode: inSelectionMode }"
      :runtime-id="folderLayoutKey(f)" runtime-surface-id="files:surface:browser"
      :runtime-selected="selectedFolderKeys.has(f.id)"
      :runtime-abilities="f.type === 'folder' && f.folderId != null ? ['move'] : []"
      :runtime-target="f.type === 'folder' && f.folderId != null ? { surfaceId: `files:surface:folder:${f.folderId}`, accepts: ['file-item', 'folder-item'], priority: 2 } : undefined"
      :data-folder-key="f.id" :data-folder-id="f.folderId"
      data-layout-role="card" :data-layout-key="folderLayoutKey(f)"
      @contextmenu.prevent.stop="openCtx('folder', f, $event)" @click.stop="handleFolderClick(f, $event)">
      <template #icon><component :is="folderListIcon(f)" class="fd-big-icon" :size="92" weight="bold" /></template>
      <template #name><span :title="f.displayName"><span v-if="renamingFolderKey === f.folderId" class="rename-sizer" @click.stop><span class="rename-ghost">{{ renameText || ' ' }}</span><input class="rename-input-inline" v-model="renameText" v-enter="commitRename" @keydown.esc="cancelRename" @blur="commitRename" @focus="($event.target as HTMLInputElement).select()" /></span><template v-else>{{ f.displayName }}</template></span></template>
      <template #actions>
        <button class="file-card-btn" :title="renamingFolderKey === f.folderId ? '确认' : '重命名'" @mousedown.prevent @click.stop="renamingFolderKey === f.folderId ? commitRename() : startRenameFolder(f)"><PhCheck v-if="renamingFolderKey === f.folderId" :size="11" weight="bold" /><PhPencilSimple v-else :size="11" weight="bold" /></button>
        <button class="file-card-btn" title="下载为 ZIP" @click.stop="downloadFolder(f)"><PhDownloadSimple :size="11" weight="bold" /></button>
        <button class="file-card-btn del" title="删除" @click.stop="deleteFolder(f)"><PhTrash :size="11" weight="bold" /></button>
      </template>
    </RuntimeFolderCard>

    <RuntimeFileCard v-for="f in sortedContents.files" :key="f.id" class="hover-card-fx"
      :card-props="{ ext: f.ext, displayName: f.displayName, hasThumb: isImageExt(f.ext), selected: selectedIds.has(f.id), preSelected: previewFileIds.has(f.id), dragging: draggingFileIds.has(f.id), cut: cbStore.type === 'cut' && cbStore.fileIds.includes(f.id) }"
      :runtime-id="fileLayoutKey(f)" runtime-surface-id="files:surface:browser"
      :runtime-selected="selectedIds.has(f.id)"
      :runtime-abilities="['move']"
      :data-file-id="f.id" data-layout-role="card" :data-layout-key="fileLayoutKey(f)" @contextmenu.prevent.stop="openCtx('file', f, $event)" @click.stop="handleFileClick(f, $event)">
      <template #thumb><img class="fc-thumb-tiny" v-lazy-src="{ id: f.id, size: 'tiny', revision: f.thumbRevision }" decoding="async" draggable="false" alt="" /><img class="fc-thumb-full" v-lazy-src="{ id: f.id, size: 'card', revision: f.thumbRevision }" :class="{ 'fc-loaded': cardBlobReadyIds.has(f.id) }" decoding="async" draggable="false" alt="" @load="cardBlobReadyIds.add(f.id)" @error="($event.target as HTMLElement).style.display='none'" /><div class="fc-thumb-fade"></div></template>
      <template #name><span v-if="renamingFileId === f.id" class="rename-sizer" @click.stop><span class="rename-ghost">{{ renameText || ' ' }}</span><input class="rename-input-inline" v-model="renameText" v-enter="commitRename" @keydown.esc="cancelRename" @blur="commitRename" @focus="($event.target as HTMLInputElement).select()" /></span><template v-else>{{ f.displayName }}</template></template>
      <template #meta>{{ f.size }} · {{ f.createdAt }}</template>
      <Transition name="sel-cb"><div v-if="inSelectionMode" class="sel-checkbox" :class="{ checked: selectedIds.has(f.id) }"><svg v-if="selectedIds.has(f.id)" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6l3 3 5-5"/></svg></div></Transition>
      <div v-if="!inSelectionMode" class="fc-hover-actions"><button class="file-card-btn" :title="renamingFileId === f.id ? '确认' : '重命名'" @mousedown.prevent @click.stop="renamingFileId === f.id ? commitRename() : startRenameFile(f)"><PhCheck v-if="renamingFileId === f.id" :size="11" weight="bold" /><PhPencilSimple v-else :size="11" weight="bold" /></button><button class="file-card-btn" title="下载" @click.stop="downloadFile(f)"><PhDownloadSimple :size="11" weight="bold" /></button><button class="file-card-btn del" title="移到回收站" @click.stop="deleteSingleFile(f)"><PhTrash :size="11" weight="bold" /></button></div>
    </RuntimeFileCard>
    <FileUploadGhostCard v-for="g in uploadingItems" :key="g.uid" :name="g.name" :ext="g.ext" :is-folder="g.isFolder" :progress="g.progress" :done="g.done" :total="g.total" :failed="g.failed" :error="g.error" data-flip-target />
    <FileUploadButton v-if="canUpload" mode="grid" data-flip-target @select="handleFileInput" />
  </FileBrowserGrid>
  <FileBrowserEmptyState v-if="contents.folders.length === 0 && contents.files.length === 0 && !loading && !canUpload" variant="grid" />
</template>

<script setup lang="ts">
import type { PropType } from 'vue'
import { PhCheck, PhDownloadSimple, PhPencilSimple, PhTrash } from '@phosphor-icons/vue'
import FileBrowserGrid from '@/components/common/file-browser/FileBrowserGrid.vue'
import FileBrowserEmptyState from '@/components/common/file-browser/FileBrowserEmptyState.vue'
import RuntimeFileCard from '@/components/common/file-browser/RuntimeFileCard.vue'
import RuntimeFolderCard from '@/components/common/file-browser/RuntimeFolderCard.vue'
import FileUploadButton from '@/components/common/file-browser/FileUploadButton.vue'
import FileUploadGhostCard from '@/components/common/file-browser/FileUploadGhostCard.vue'
import { vLazyThumb as vLazySrc } from '@/composables/useLazyThumb'
const props = defineProps({ context: { type: Object as PropType<Record<string, any>>, required: true } })
const { contents, sortedContents, selectedFolderKeys, previewFolderKeys, dragOverFolderId, inSelectionMode, openCtx, folderListIcon, folderAccentColor, handleFolderClick, renamingFolderKey, renameText, commitRename, cancelRename, startRenameFolder, downloadFolder, deleteFolder, selectedIds, previewFileIds, draggingFileIds, cbStore, handleFileClick, isImageExt, cardBlobReadyIds, renamingFileId, startRenameFile, downloadFile, deleteSingleFile, uploadingItems, canUpload, handleFileInput, loading, folderLayoutKey, fileLayoutKey, layoutCollection } = props.context
</script>

<style scoped>
.file-browser-grid.file-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(158px,1fr)); gap:10px; align-content:start; }
.sel-checkbox { position:absolute; top:8px; right:8px; z-index:3; width:18px; height:18px; border-radius:5px; border:2px solid rgba(123,127,178,.55); background:rgba(255,255,255,.75); display:flex; align-items:center; justify-content:center; pointer-events:none; }
.sel-checkbox.checked { background:var(--color-primary,#7b7fb2); border-color:var(--color-primary,#7b7fb2); }
.fc-hover-actions { position:absolute; right:8px; bottom:8px; display:flex; gap:3px; opacity:0; transition:opacity .15s; }
.fc-card:hover .fc-hover-actions { opacity:1; }
.fc-thumb-tiny,.fc-thumb-full { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; }
.fc-thumb-tiny { filter:blur(10px); transform:scale(1.06); opacity:.7; }
.fc-thumb-full { opacity:0; transition:opacity .2s; }
.fc-thumb-full.fc-loaded { opacity:1; }
.sel-cb-enter-active,.sel-cb-leave-active { transition:opacity .18s ease; }
.sel-cb-enter-from,.sel-cb-leave-to { opacity:0; }
</style>
