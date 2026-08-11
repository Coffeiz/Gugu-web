<template>
  <div ref="elementRef" class="list-row folder-row" :class="{ selected: selectedFolderKeys.has(item.id), 'pre-selected': previewFolderKeys.has(item.id) }" :data-folder-key="item.id" :data-folder-id="item.folderId" data-layout-role="card" :data-layout-key="runtimeId" @click.stop="handleFolderClick(item, $event)" @contextmenu.prevent.stop="openCtx('folder', item, $event)">
    <span class="lr-name-cell"><component :is="folderListIcon(item)" class="lr-folder-icon" :size="16" weight="fill" :style="{ color: folderAccentColor(item) }" /><span class="lr-filename" :title="item.displayName"><RenameInput v-if="renamingFolderKey === item.folderId" v-model="renameText" @commit="commitRename" @cancel="cancelRename" /><template v-else>{{ item.displayName }}</template></span></span>
    <span class="lr-type-text">文件夹</span><span class="lr-text">—</span><span class="lr-text">{{ item.count != null ? item.count + ' 项' : '—' }}</span><span class="lr-text">—</span>
    <span class="lr-actions"><Transition name="sel-cb"><div v-if="inSelectionMode" class="sel-checkbox" :class="{ checked: selectedFolderKeys.has(item.id) }"><svg v-if="selectedFolderKeys.has(item.id)" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round"><path d="M2 6l3 3 5-5"/></svg></div></Transition><template v-if="item.type === 'folder' && !inSelectionMode"><button class="file-list-btn" @mousedown.prevent @click.stop="renamingFolderKey === item.folderId ? commitRename() : startRenameFolder(item)"><PhCheck v-if="renamingFolderKey === item.folderId" :size="11" /><PhPencilSimple v-else :size="11" /></button><button class="file-list-btn" title="下载为 ZIP" @click.stop="downloadFolder(item)"><PhDownloadSimple :size="11" /></button><button class="file-list-btn del" title="删除" @click.stop="deleteFolder(item)"><PhTrash :size="11" /></button></template></span>
  </div>
</template>

<script setup lang="ts">
import type { PropType } from 'vue'
import { PhCheck, PhDownloadSimple, PhPencilSimple, PhTrash } from '@phosphor-icons/vue'
import RenameInput from '@/components/common/file-browser/RenameInput.vue'
import { useObject, useSurface, type ObjectTargetOptions } from '@/interaction/runtime/vue'
import type { FolderCard as FolderCardMeta } from '@/utils/filesNav'

const props = defineProps({ item: { type: Object as PropType<FolderCardMeta>, required: true }, context: { type: Object as PropType<Record<string, any>>, required: true }, runtimeId: { type: String, required: true }, runtimeSurfaceId: { type: String, required: true }, runtimeAbilities: { type: Array as PropType<readonly string[]>, default: () => ['move'] }, runtimeSelected: { type: Boolean, default: false }, runtimeTarget: { type: Object as PropType<ObjectTargetOptions | undefined>, default: undefined } })
const targetSurfaceId = props.runtimeTarget?.surfaceId ?? `${props.runtimeId}:surface`
useSurface({ id: targetSurfaceId, type: 'file-folder', accepts: ['file-item', 'folder-item'] })
const { elementRef } = useObject({ id: props.runtimeId, type: 'folder-item', surface: () => props.runtimeSurfaceId, abilities: () => props.runtimeAbilities, selected: () => props.runtimeSelected, target: () => props.runtimeTarget })
const { selectedFolderKeys, previewFolderKeys, handleFolderClick, openCtx, folderListIcon, folderAccentColor, renamingFolderKey, renameText, commitRename, cancelRename, startRenameFolder, downloadFolder, deleteFolder, inSelectionMode } = props.context
</script>

<style src="./filesListRows.css"></style>
