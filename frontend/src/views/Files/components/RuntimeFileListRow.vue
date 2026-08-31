<template>
  <div ref="elementRef" class="list-row" :class="{ selected: selectedIds.has(item.id), 'pre-selected': previewFileIds.has(item.id), cut: cbStore.type === 'cut' && cbStore.fileIds.includes(item.id) }" :data-file-id="item.id" data-layout-role="card" :data-layout-key="runtimeId" @contextmenu.prevent.stop="openCtx('file', item, $event)" @click.stop="handleFileClick(item, $event)">
    <span class="lr-name-cell"><component :is="fileListIcon(item.ext)" class="lr-file-icon" :size="16" :style="{ color: fileIconColor(item.ext) }" /><span class="lr-filename" :title="item.displayName"><RenameInput v-if="renamingFileId === item.id" v-model="renameText" @commit="commitRename" @cancel="cancelRename" /><template v-else>{{ item.displayName }}</template></span></span>
    <span class="lr-type-cell"><span class="lr-ext" :style="{ color: fileIconColor(item.ext), background: fileIconColor(item.ext) + '18' }">{{ item.ext }}</span></span>
    <span class="lr-proj-cell"><span v-if="item.projectColor" class="lr-dot" :style="{ background: item.projectColor || '' }"></span><span class="lr-projname">{{ item.projectName || item.stageName || '—' }}</span></span><span class="lr-text">{{ item.size }}</span><span class="lr-text">{{ item.createdAt }}</span>
    <span class="lr-actions"><Transition name="sel-cb"><div v-if="inSelectionMode" class="sel-checkbox" :class="{ checked: selectedIds.has(item.id) }"><svg v-if="selectedIds.has(item.id)" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round"><path d="M2 6l3 3 5-5"/></svg></div></Transition><template v-if="!inSelectionMode"><button class="file-list-btn" :title="renamingFileId === item.id ? t('filesViewUi.confirm') : t('filesViewUi.rename')" @mousedown.prevent @click.stop="renamingFileId === item.id ? commitRename() : startRenameFile(item)"><Icon name="status.success" v-if="renamingFileId === item.id" :size="11" /><Icon name="action.edit" v-else :size="11" /></button><button class="file-list-btn" :title="t('filesViewUi.download')" @click.stop="downloadFile(item)"><Icon name="action.download" :size="11" /></button><button class="file-list-btn del" :title="t('filesViewUi.moveToTrash')" @click.stop="deleteSingleFile(item)"><Icon name="action.delete" :size="11" /></button></template></span>
  </div>
</template>

<script setup lang="ts">
import { onUnmounted, ref, watch, type PropType } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import RenameInput from '@/components/common/file-browser/RenameInput.vue'
import { runtime } from '@/interaction/runtime'
import type { FileMeta } from '@/stores/filesCache'

const props = defineProps({ item: { type: Object as PropType<FileMeta>, required: true }, context: { type: Object as PropType<Record<string, any>>, required: true }, runtimeId: { type: String, required: true }, runtimeSurfaceId: { type: String, required: true }, runtimeAbilities: { type: Array as PropType<readonly string[]>, default: () => ['move'] }, runtimeSelected: { type: Boolean, default: false } })
const { t } = useI18n()
const elementRef = ref<HTMLElement | null>(null)
const generation = runtime.objects.register({ id: props.runtimeId, type: 'file-item', surfaceId: props.runtimeSurfaceId, abilities: [...props.runtimeAbilities], selected: props.runtimeSelected, element: null })
let stopPointerBinding: (() => void) | null = null
watch(() => [props.runtimeSurfaceId, props.runtimeAbilities, props.runtimeSelected] as const, ([surfaceId, abilities, selected]) => {
  if (runtime.objects.get(props.runtimeId)?.generation !== generation) return
  runtime.objects.update(props.runtimeId, { surfaceId, abilities: [...abilities], selected })
}, { deep: true })
watch(elementRef, (element, previous) => {
  const current = runtime.objects.get(props.runtimeId)
  if (current?.generation !== generation) return
  if (element === null && current.element && current.element !== previous) return
  stopPointerBinding?.()
  stopPointerBinding = element ? runtime.bindObjectPointer(props.runtimeId, element) : null
  runtime.objects.setElement(props.runtimeId, element)
}, { flush: 'post' })
onUnmounted(() => {
  stopPointerBinding?.()
  if (runtime.objects.get(props.runtimeId)?.generation === generation) runtime.unregisterObjectWhenIdle(props.runtimeId, generation)
})
const { selectedIds, previewFileIds, cbStore, handleFileClick, openCtx, fileListIcon, fileIconColor, renamingFileId, renameText, commitRename, cancelRename, startRenameFile, downloadFile, deleteSingleFile, inSelectionMode } = props.context
</script>
