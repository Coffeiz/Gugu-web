<script setup lang="ts">
import type { PropType } from 'vue'
import { i18n } from '@/i18n'
import FolderCard from '@/components/common/file-browser/FolderCard.vue'
import FileBrowserGrid from '@/components/common/file-browser/FileBrowserGrid.vue'
import FileBrowserList from '@/components/common/file-browser/FileBrowserList.vue'
import type { FolderCard as FolderCardMeta } from '@/utils/filesNav'
import Icon from '@/components/common/icons/Icon.vue'
import { useFileLibraryFolderPresentation } from '@/composables/files/useFileLibraryFolderPresentation'

defineProps({
  entries: { type: Array as PropType<FolderCardMeta[]>, required: true },
  viewMode: { type: String as PropType<'grid' | 'list'>, required: true },
  layoutCollection: { type: String, required: true },
})
defineEmits<{ open: [location: FolderCardMeta] }>()
const t = i18n.global.t
function countLabel(entry: FolderCardMeta) {
  if (entry.fileCount != null && entry.folderCount != null)
    return t('filesViewUi.folderContents', { files: entry.fileCount, folders: entry.folderCount })
  return entry.count == null ? '—' : t('filesViewUi.items', { count: entry.count })
}
const { folderListIcon, folderAccentColor } = useFileLibraryFolderPresentation()

</script>

<template>
  <FileBrowserGrid v-if="viewMode === 'grid'" :layout-collection="layoutCollection">
    <FolderCard v-for="entry in entries" :key="entry.id" :display-name="entry.displayName"
      :count-label="countLabel(entry)"
      :accent-color="folderAccentColor(entry)" :data-layout-key="entry.id" data-layout-role="card"
      role="button" tabindex="0" @click="$emit('open', entry)" @keydown.enter.prevent="$emit('open', entry)">
      <template #icon>
        <Icon v-if="entry.id.startsWith('desktop:')" name="file.folder-chart" class="fd-big-icon" :size="92" />
        <component v-else :is="folderListIcon(entry)" class="fd-big-icon" :size="92" />
      </template>
    </FolderCard>
  </FileBrowserGrid>
  <FileBrowserList v-else :layout-collection="layoutCollection" class="desktop-location-list">
    <div class="list-head"><span>{{ t('filesViewUi.name') }}</span></div>
    <button v-for="entry in entries" :key="entry.id" type="button" class="list-row folder-row"
      :data-layout-key="entry.id" data-layout-role="card" @click="$emit('open', entry)">
      <span class="lr-name-cell">
        <Icon v-if="entry.id.startsWith('desktop:')" name="file.folder-chart" class="lr-folder-icon" :size="16" />
        <component v-else :is="folderListIcon(entry)" class="lr-folder-icon" :size="16" />
        <span class="lr-filename">{{ entry.displayName }}</span>
        <span v-if="entry.fileCount != null || entry.count != null">{{ countLabel(entry) }}</span>
      </span>
    </button>
  </FileBrowserList>
</template>

<style scoped>
.desktop-location-list :is(.list-head, .list-row) { grid-template-columns: minmax(0, 1fr); }
.desktop-location-list button.list-row {
  width: 100%;
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
}
</style>
