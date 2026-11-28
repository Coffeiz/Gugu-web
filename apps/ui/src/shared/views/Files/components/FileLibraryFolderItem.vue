<script setup lang="ts">
import type { PropType } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/icons/Icon.vue'
import FolderCard from '@/components/common/file-browser/FolderCard.vue'
import { useFileLibraryFolderPresentation } from '@/composables/files/useFileLibraryFolderPresentation'
import type { FolderCard as Folder } from '@/utils/filesNav'

defineProps({
  item: { type: Object as PropType<Folder>, required: true },
  mode: { type: String as PropType<'grid' | 'list'>, required: true },
  layoutKey: { type: String, required: true },
})
defineEmits<{ open: [] }>()
const { t } = useI18n()
const { folderListIcon, folderAccentColor } = useFileLibraryFolderPresentation()
function countLabel(item: Folder) {
  if (item.fileCount != null && item.folderCount != null)
    return t('filesViewUi.folderContents', { files: item.fileCount, folders: item.folderCount })
  return item.count == null ? undefined : t('filesUi.itemCount', { count: item.count })
}
</script>

<template>
  <FolderCard v-if="mode === 'grid'" :display-name="item.displayName"
    :count-label="countLabel(item)" :data-layout-key="layoutKey" data-layout-role="card"
    :accent-color="item.type === 'workspace' ? 'var(--accent-primary)' : folderAccentColor(item)"
    role="button" tabindex="0" @click.stop="$emit('open')"
    @keydown.enter.self.prevent="$emit('open')" @keydown.space.self.prevent="$emit('open')">
    <template #icon>
      <Icon v-if="item.type === 'workspace'" name="file.folder-chart" class="fd-big-icon" :size="92" />
      <component v-else :is="folderListIcon(item)" class="fd-big-icon" :size="92" />
    </template>
    <template v-if="$slots.name" #name><slot name="name" /></template>
    <template v-if="$slots.actions" #actions><slot name="actions" /></template>
  </FolderCard>
  <div v-else class="list-row folder-row" role="button" tabindex="0"
    :data-layout-key="layoutKey" data-layout-role="card"
    @click.stop="$emit('open')" @keydown.enter.self.prevent="$emit('open')" @keydown.space.self.prevent="$emit('open')">
    <span class="lr-name-cell">
      <Icon v-if="item.type === 'workspace'" name="file.folder-chart" class="lr-folder-icon" :size="16" />
      <component v-else :is="folderListIcon(item)" class="lr-folder-icon" :size="16"
        :style="{ color: folderAccentColor(item) }" />
      <span class="lr-filename" :title="item.displayName"><slot name="name">{{ item.displayName }}</slot></span>
    </span>
    <span class="lr-type-text">{{ t(item.type === 'workspace' ? 'workspaceUi.workspaceDirectories' : 'filesUi.folderType') }}</span>
    <span class="lr-text">—</span>
    <span class="lr-text">{{ countLabel(item) ?? '—' }}</span>
    <span class="lr-text">—</span>
    <span class="lr-actions"><slot name="actions" /></span>
  </div>
</template>
