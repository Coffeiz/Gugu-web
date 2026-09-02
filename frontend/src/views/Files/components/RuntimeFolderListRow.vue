<template>
  <div ref="elementRef" class="list-row folder-row" :class="{ selected: selectedFolderKeys.has(item.id), 'pre-selected': previewFolderKeys.has(item.id) }" :data-folder-key="item.id" :data-folder-id="item.folderId" data-layout-role="card" :data-layout-key="runtimeId" @click.stop="handleFolderClick(item, $event)" @contextmenu.prevent.stop="openCtx('folder', item, $event)">
    <span class="lr-name-cell"><component :is="folderListIcon(item)" class="lr-folder-icon" :size="16" :style="{ color: folderAccentColor(item) }" /><span class="lr-filename" :title="item.displayName"><RenameInput v-if="renamingFolderKey === item.folderId" v-model="renameText" @commit="commitRename" @cancel="cancelRename" /><template v-else>{{ item.displayName }}</template></span></span>
    <span class="lr-type-text">{{ t('filesUi.folderType') }}</span><span class="lr-text">—</span><span class="lr-text">{{ item.count != null ? t('filesUi.itemCount', { count: item.count }) : '—' }}</span><span class="lr-text">—</span>
    <span class="lr-actions"><Transition name="sel-cb"><div v-if="inSelectionMode" class="sel-checkbox" :class="{ checked: selectedFolderKeys.has(item.id) }"><svg v-if="selectedFolderKeys.has(item.id)" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round"><path d="M2 6l3 3 5-5"/></svg></div></Transition><template v-if="item.type === 'folder' && !inSelectionMode"><button class="file-list-btn" @mousedown.prevent @click.stop="renamingFolderKey === item.folderId ? commitRename() : startRenameFolder(item)"><Icon name="status.success" v-if="renamingFolderKey === item.folderId" :size="11" /><Icon name="action.edit" v-else :size="11" /></button><button class="file-list-btn" :title="t('filesUi.downloadZip')" @click.stop="downloadFolder(item)"><Icon name="action.download" :size="11" /></button><button class="file-list-btn del" :title="t('common.actions.delete')" @click.stop="deleteFolder(item)"><Icon name="action.delete" :size="11" /></button></template></span>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
import { onUnmounted, ref, watch, type PropType } from 'vue'
import Icon from '@/components/common/icons/Icon.vue'
import RenameInput from '@/components/common/file-browser/RenameInput.vue'
import { runtime, bindRuntimeObjectPointer, type TargetItem } from '@/interaction/runtime'
import type { FolderCard as FolderCardMeta } from '@/utils/filesNav'

const props = defineProps({ item: { type: Object as PropType<FolderCardMeta>, required: true }, context: { type: Object as PropType<Record<string, any>>, required: true }, runtimeId: { type: String, required: true }, runtimeSurfaceId: { type: String, required: true }, runtimeAbilities: { type: Array as PropType<readonly string[]>, default: () => ['move'] }, runtimeSelected: { type: Boolean, default: false }, runtimeTarget: { type: Object as PropType<Omit<TargetItem, 'id' | 'element' | 'generation'> | undefined>, default: undefined } })
const targetSurfaceId = props.runtimeTarget?.surfaceId ?? `${props.runtimeId}:surface`
const targetSurfaceGeneration = runtime.surfaces.register({ id: targetSurfaceId, type: 'file-folder', layout: 'grid', accepts: ['file-item', 'folder-item'], element: null })
const elementRef = ref<HTMLElement | null>(null)
const generation = runtime.objects.register({ id: props.runtimeId, type: 'folder-item', surfaceId: props.runtimeSurfaceId, abilities: [...props.runtimeAbilities], selected: props.runtimeSelected, target: props.runtimeTarget, element: null })
let stopPointerBinding: (() => void) | null = null
watch(() => [props.runtimeSurfaceId, props.runtimeAbilities, props.runtimeSelected, props.runtimeTarget] as const, ([surfaceId, abilities, selected, target]) => {
  if (runtime.objects.get(props.runtimeId)?.generation !== generation) return
  runtime.objects.update(props.runtimeId, { surfaceId, abilities: [...abilities], selected, target })
}, { deep: true })
watch(elementRef, (element, previous) => {
  const current = runtime.objects.get(props.runtimeId)
  if (current?.generation !== generation) return
  if (element === null && current.element && current.element !== previous) return
  stopPointerBinding?.()
  stopPointerBinding = element ? bindRuntimeObjectPointer(props.runtimeId, element) : null
  runtime.objects.setElement(props.runtimeId, element)
}, { flush: 'post' })
onUnmounted(() => {
  stopPointerBinding?.()
  if (runtime.objects.get(props.runtimeId)?.generation === generation) runtime.unregisterObjectWhenIdle(props.runtimeId, generation)
  if (runtime.surfaces.get(targetSurfaceId)?.generation === targetSurfaceGeneration) runtime.surfaces.unregister(targetSurfaceId, targetSurfaceGeneration)
})
const { selectedFolderKeys, previewFolderKeys, handleFolderClick, openCtx, folderListIcon, folderAccentColor, renamingFolderKey, renameText, commitRename, cancelRename, startRenameFolder, downloadFolder, deleteFolder, inSelectionMode } = props.context
</script>
