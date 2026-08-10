<template>
  <div ref="elementRef" class="list-row" :class="{ selected: selectedIds.has(item.id), 'pre-selected': previewFileIds.has(item.id), dragging: draggingFileIds.has(item.id), cut: cbStore.type === 'cut' && cbStore.fileIds.includes(item.id) }" :data-file-id="item.id" data-layout-role="card" :data-layout-key="runtimeId" @contextmenu.prevent.stop="openCtx('file', item, $event)" @click.stop="handleFileClick(item, $event)">
    <span class="lr-name-cell"><component :is="fileListIcon(item.ext)" class="lr-file-icon" :size="16" weight="fill" :style="{ color: fileIconColor(item.ext) }" /><span class="lr-filename" :title="item.displayName"><RenameInput v-if="renamingFileId === item.id" v-model="renameText" @commit="commitRename" @cancel="cancelRename" /><template v-else>{{ item.displayName }}</template></span></span>
    <span class="lr-type-cell"><span class="lr-ext" :style="{ color: fileIconColor(item.ext), background: fileIconColor(item.ext) + '18' }">{{ item.ext }}</span></span>
    <span class="lr-proj-cell"><span v-if="item.projectColor" class="lr-dot" :style="{ background: item.projectColor || '' }"></span><span class="lr-projname">{{ item.projectName || item.stageName || '—' }}</span></span><span class="lr-text">{{ item.size }}</span><span class="lr-text">{{ item.createdAt }}</span>
    <span class="lr-actions"><Transition name="sel-cb"><div v-if="inSelectionMode" class="sel-checkbox" :class="{ checked: selectedIds.has(item.id) }"><svg v-if="selectedIds.has(item.id)" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round"><path d="M2 6l3 3 5-5"/></svg></div></Transition><template v-if="!inSelectionMode"><button class="file-list-btn" @mousedown.prevent @click.stop="renamingFileId === item.id ? commitRename() : startRenameFile(item)"><PhCheck v-if="renamingFileId === item.id" :size="11" /><PhPencilSimple v-else :size="11" /></button><button class="file-list-btn" title="下载" @click.stop="downloadFile(item)"><PhDownloadSimple :size="11" /></button><button class="file-list-btn del" title="移到回收站" @click.stop="deleteSingleFile(item)"><PhTrash :size="11" /></button></template></span>
  </div>
</template>

<script setup lang="ts">
import type { PropType } from 'vue'
import { PhCheck, PhDownloadSimple, PhPencilSimple, PhTrash } from '@phosphor-icons/vue'
import RenameInput from '@/components/common/file-browser/RenameInput.vue'
import { useObject } from '@/interaction/runtime/vue'
import type { FileMeta } from '@/stores/filesCache'

const props = defineProps({ item: { type: Object as PropType<FileMeta>, required: true }, context: { type: Object as PropType<Record<string, any>>, required: true }, runtimeId: { type: String, required: true }, runtimeSurfaceId: { type: String, required: true }, runtimeAbilities: { type: Array as PropType<readonly string[]>, default: () => ['move'] }, runtimeSelected: { type: Boolean, default: false } })
const { elementRef } = useObject({ id: props.runtimeId, type: 'file-item', surface: () => props.runtimeSurfaceId, abilities: () => props.runtimeAbilities, selected: () => props.runtimeSelected })
const { selectedIds, previewFileIds, draggingFileIds, cbStore, handleFileClick, openCtx, fileListIcon, fileIconColor, renamingFileId, renameText, commitRename, cancelRename, startRenameFile, downloadFile, deleteSingleFile, inSelectionMode } = props.context
</script>

<style src="./filesListRows.css"></style>
