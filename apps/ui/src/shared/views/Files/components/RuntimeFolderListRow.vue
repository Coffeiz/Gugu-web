<template>
  <FileLibraryFolderItem ref="row" :item="item" mode="list" :layout-key="runtimeId"
    @open="openFolder(item)" @contextmenu.prevent.stop />
</template>

<script setup lang="ts">
import { onUnmounted, ref, watchEffect, type PropType } from 'vue'
import FileLibraryFolderItem from './FileLibraryFolderItem.vue'
import { runtime } from '@/interaction/runtime'
import { useFileRuntimeObject } from '@/composables/files/useFileRuntimeObject'
import type { FolderCard } from '@/utils/filesNav'

const props = defineProps({
  item: { type: Object as PropType<FolderCard>, required: true },
  openFolder: { type: Function as PropType<(item: FolderCard) => void>, required: true },
  runtimeId: { type: String, required: true },
  runtimeSurfaceId: { type: String, required: true },
  runtimeAbilities: { type: Array as PropType<readonly string[]>, default: () => [] },
})
const row = ref<InstanceType<typeof FileLibraryFolderItem> | null>(null)
const targetSurfaceId = `${props.runtimeId}:surface`
const targetSurfaceGeneration = runtime.surfaces.register({ id: targetSurfaceId, type: 'file-folder', layout: 'grid', accepts: ['file-item', 'folder-item'], element: null })
const { elementRef } = useFileRuntimeObject(() => props.runtimeId, () => ({
  type: 'folder-item', surfaceId: props.runtimeSurfaceId, abilities: props.runtimeAbilities, selected: false,
}))
watchEffect(() => { elementRef.value = row.value?.$el ?? null })
onUnmounted(() => {
  if (runtime.surfaces.get(targetSurfaceId)?.generation === targetSurfaceGeneration) runtime.surfaces.unregister(targetSurfaceId, targetSurfaceGeneration)
})
</script>
