<template>
  <FileBrowserList ref="browserRef" :layout-collection="layoutCollection">
    <div class="list-head">
      <span v-for="item in headers" :key="item.key" class="lh-sortable"
        :class="{ active: sortKey === item.key }" @click="item.key && onSortSelect(item.key)">
        {{ item.label }}
        <FileListSortArrow v-if="item.key" :descending="sortKey === item.key && sortDir === 'desc'" />
      </span>
    </div>
    <div v-if="top" :style="{ height: Math.max(0, top - 2) + 'px', flexShrink: 0 }" aria-hidden="true" />
    <RuntimeFolderListRow v-for="folder in visibleFolders" :key="folder.id" :item="folder"
      :open-folder="openFolder"
      :runtime-id="folderLayoutKey(folder)" runtime-surface-id="files:surface:browser"
      :runtime-abilities="[]" />
    <slot />
    <div v-if="bottom" :style="{ height: Math.max(0, bottom - 2) + 'px', flexShrink: 0 }" aria-hidden="true" />
    <FileBrowserEmptyState v-if="contents.folders.length === 0" variant="list" :loading="loading"
      :text="loading ? t('common.status.loading') : undefined" />
  </FileBrowserList>
</template>

<script setup lang="ts">
import FileListSortArrow from './FileListSortArrow.vue'
import type { PropType } from 'vue'
import { computed, watch } from 'vue'
import FileBrowserList from '@/components/common/file-browser/FileBrowserList.vue'
import FileBrowserEmptyState from '@/components/common/file-browser/FileBrowserEmptyState.vue'
import RuntimeFolderListRow from '@/views/Files/components/RuntimeFolderListRow.vue'
import { useFileBrowserWindow } from '@/composables/files/useFileBrowserWindow'
import { useI18n } from 'vue-i18n'
import { runtime } from '@/interaction/runtime'

const props = defineProps({ context: { type: Object as PropType<Record<string, any>>, required: true } })
const { t } = useI18n()
const { contents, sortedContents, sortKey, sortDir, onSortSelect,
  folderLayoutKey, openFolder, loading, layoutCollection, viewMode } = props.context
const headers = computed(() => [
  { key: 'name', label: t('filesViewUi.name') },
  { key: '', label: t('filesViewUi.type') },
  { key: '', label: t('filesViewUi.projectStage') },
  { key: '', label: t('filesViewUi.size') },
  { key: '', label: t('filesViewUi.date') },
  { key: '', label: '' },
])
const { browserRef, visibleFolders, top, bottom } = useFileBrowserWindow(sortedContents, 'list', {
  resetKey: () => props.context.directoryViewportKey.value,
})
function syncFileDragRotation(mode: 'grid' | 'list') {
  runtime.configureMotion({ controller: { rotation: { tilt: mode === 'list' ? 0 : 5 } } })
}
watch(viewMode, syncFileDragRotation, { immediate: true })
</script>
