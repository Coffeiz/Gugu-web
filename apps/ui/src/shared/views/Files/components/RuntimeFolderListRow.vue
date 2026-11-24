<template>
  <div ref="elementRef" class="list-row folder-row" data-layout-role="card" :data-layout-key="runtimeId"
    @click.stop="openFolder(item)" @contextmenu.prevent.stop>
    <span class="lr-name-cell"><component :is="folderListIcon(item)" class="lr-folder-icon" :size="16"
      :style="{ color: folderAccentColor(item) }" /><span class="lr-filename" :title="item.displayName">{{ item.displayName }}</span></span>
    <span class="lr-type-text">{{ t('filesUi.folderType') }}</span><span class="lr-text">—</span>
    <span class="lr-text">{{ item.count != null ? t('filesUi.itemCount', { count: item.count }) : '—' }}</span>
    <span class="lr-text">—</span><span class="lr-actions" />
  </div>
</template>

<script setup lang="ts">
import { onUnmounted, type PropType } from 'vue'
import { useI18n } from 'vue-i18n'
import { runtime } from '@/interaction/runtime'
import { useFileRuntimeObject } from '@/composables/files/useFileRuntimeObject'
import type { FolderCard } from '@/utils/filesNav'

const props = defineProps({
  item: { type: Object as PropType<FolderCard>, required: true },
  openFolder: { type: Function as PropType<(item: FolderCard) => void>, required: true },
  folderListIcon: { type: Function as PropType<(item: FolderCard) => unknown>, required: true },
  folderAccentColor: { type: Function as PropType<(item: FolderCard) => string>, required: true },
  runtimeId: { type: String, required: true },
  runtimeSurfaceId: { type: String, required: true },
  runtimeAbilities: { type: Array as PropType<readonly string[]>, default: () => [] },
})
const { t } = useI18n()
const targetSurfaceId = `${props.runtimeId}:surface`
const targetSurfaceGeneration = runtime.surfaces.register({ id: targetSurfaceId, type: 'file-folder', layout: 'grid', accepts: ['file-item', 'folder-item'], element: null })
const { elementRef } = useFileRuntimeObject(() => props.runtimeId, () => ({
  type: 'folder-item', surfaceId: props.runtimeSurfaceId, abilities: props.runtimeAbilities, selected: false,
}))
onUnmounted(() => {
  if (runtime.surfaces.get(targetSurfaceId)?.generation === targetSurfaceGeneration) runtime.surfaces.unregister(targetSurfaceId, targetSurfaceGeneration)
})
</script>
