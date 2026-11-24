<template>
  <FileBrowserGrid ref="browserRef" :class="{ 'is-virtual': virtualEnabled }" :style="gridStyle" :layout-collection="layoutCollection">
    <RuntimeFolderCard v-for="folder in visibleFolders" :key="folder.id"
      :card-props="{ displayName: folder.displayName, countLabel: folder.fileCount != null && folder.folderCount != null ? t('filesViewUi.folderContents', { files: folder.fileCount, folders: folder.folderCount }) : folder.count != null ? t('filesViewUi.items', { count: folder.count }) : '—', accentColor: folderAccentColor(folder), selected: false, preSelected: false, cut: false, selectionMode: false }"
      :runtime-id="folderLayoutKey(folder)" runtime-surface-id="files:surface:browser"
      :runtime-abilities="[]" data-layout-role="card" :data-layout-key="folderLayoutKey(folder)"
      @contextmenu.prevent.stop @click.stop="openFolder(folder)">
      <template #icon><component :is="folderListIcon(folder)" class="fd-big-icon" :size="92" /></template>
      <template #name><span :title="folder.displayName">{{ folder.displayName }}</span></template>
    </RuntimeFolderCard>
    <slot />
  </FileBrowserGrid>
  <FileBrowserEmptyState v-if="contents.folders.length === 0" variant="grid" :loading="loading"
    :text="loading ? t('common.status.loading') : undefined" />
</template>

<script setup lang="ts">
import { type PropType } from 'vue'
import FileBrowserGrid from '@/components/common/file-browser/FileBrowserGrid.vue'
import FileBrowserEmptyState from '@/components/common/file-browser/FileBrowserEmptyState.vue'
import RuntimeFolderCard from '@/components/common/file-browser/RuntimeFolderCard.vue'
import { useFileBrowserWindow } from '@/composables/files/useFileBrowserWindow'
import { useI18n } from 'vue-i18n'

const props = defineProps({ context: { type: Object as PropType<Record<string, any>>, required: true } })
const { t } = useI18n()
const { contents, sortedContents, folderAccentColor, folderListIcon, folderLayoutKey, openFolder, loading, layoutCollection } = props.context
const { browserRef, visibleFolders, gridStyle, virtualEnabled } = useFileBrowserWindow(sortedContents, 'grid', {
  resetKey: () => props.context.directoryViewportKey.value,
})
</script>
