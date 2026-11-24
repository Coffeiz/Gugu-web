<script setup lang="ts">
import { ref, watch, type PropType } from 'vue'
import type { DesktopFileDirectory } from '@gugu/core/desktop'
import RenameInput from '@/components/common/file-browser/RenameInput.vue'
import { i18n } from '@/i18n'
import FolderCard from '@/components/common/file-browser/FolderCard.vue'
import FileBrowserGrid from '@/components/common/file-browser/FileBrowserGrid.vue'
import FileBrowserList from '@/components/common/file-browser/FileBrowserList.vue'
import type { FolderCard as FolderCardMeta } from '@/utils/filesNav'
import Icon from '@/components/common/icons/Icon.vue'
import { useFileLibraryFolderPresentation } from '@/composables/files/useFileLibraryFolderPresentation'

const props = defineProps({
  entries: { type: Array as PropType<FolderCardMeta[]>, required: true },
  viewMode: { type: String as PropType<'grid' | 'list'>, required: true },
  layoutCollection: { type: String, required: true },
  manageWorkspaces: Boolean,
  busy: Boolean,
  renameWorkspace: { type: Function as PropType<(id: DesktopFileDirectory, name: string) => Promise<unknown>>, required: true },
})
defineEmits<{ open: [location: FolderCardMeta]; unbind: [id: DesktopFileDirectory] }>()
const renameId = ref<string>()
const renameName = ref('')
function canManage(entry: FolderCardMeta) {
  return props.manageWorkspaces && entry.id.startsWith('desktop:')
}
function closeRename() { renameId.value = undefined }
function startRename(entry: FolderCardMeta) {
  renameName.value = entry.displayName
  renameId.value = entry.id
}
async function commitRename(entry: FolderCardMeta) {
  const name = renameName.value.trim()
  if (props.busy || renameId.value !== entry.id) return
  if (!name || name === entry.displayName) {
    closeRename()
    return
  }
  if (await props.renameWorkspace(entry.id as DesktopFileDirectory, name)) closeRename()
}
watch(() => props.viewMode, closeRename)
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
      role="button" tabindex="0" @click="$emit('open', entry)" @keydown.enter.self.prevent="$emit('open', entry)">
      <template #icon>
        <Icon v-if="entry.id.startsWith('desktop:')" name="file.folder-chart" class="fd-big-icon" :size="92" />
        <component v-else :is="folderListIcon(entry)" class="fd-big-icon" :size="92" />
      </template>
      <template v-if="canManage(entry)" #name>
        <RenameInput v-if="renameId === entry.id" v-model="renameName" @commit="commitRename(entry)" @cancel="closeRename" />
        <span v-else :title="entry.displayName">{{ entry.displayName }}</span>
      </template>
      <template v-if="canManage(entry)" #actions>
        <button type="button" class="file-card-btn" :disabled="busy" :title="t('workspaceUi.renameWorkspace')"
          :aria-label="t('workspaceUi.renameWorkspace')" @mousedown.prevent @click.stop="startRename(entry)">
          <Icon name="action.edit" :size="11" />
        </button>
        <button type="button" class="file-card-btn del" :disabled="busy" :title="t('filesUi.unbindDesktopWorkspace')"
          :aria-label="t('filesUi.unbindDesktopWorkspace')" @click.stop="$emit('unbind', entry.id as DesktopFileDirectory)">
          <Icon name="action.delete" :size="11" />
        </button>
      </template>
    </FolderCard>
  </FileBrowserGrid>
  <FileBrowserList v-else :layout-collection="layoutCollection" class="desktop-location-list">
    <div class="list-head"><span>{{ t('filesViewUi.name') }}</span></div>
    <div v-for="entry in entries" :key="entry.id" role="button" tabindex="0" class="list-row folder-row"
      :class="{ 'has-actions': canManage(entry) }" @keydown.enter.self.prevent="$emit('open', entry)"
      @keydown.space.self.prevent="$emit('open', entry)"
      :data-layout-key="entry.id" data-layout-role="card" @click="$emit('open', entry)">
      <span class="lr-name-cell">
        <Icon v-if="entry.id.startsWith('desktop:')" name="file.folder-chart" class="lr-folder-icon" :size="16" />
        <component v-else :is="folderListIcon(entry)" class="lr-folder-icon" :size="16" />
        <span class="lr-filename">
          <RenameInput v-if="renameId === entry.id" v-model="renameName" @commit="commitRename(entry)" @cancel="closeRename" />
          <template v-else>{{ entry.displayName }}</template>
        </span>
        <span v-if="entry.fileCount != null || entry.count != null">{{ countLabel(entry) }}</span>
      </span>
      <span v-if="canManage(entry)" class="lr-actions">
        <button type="button" class="file-list-btn" :disabled="busy" :title="t('workspaceUi.renameWorkspace')"
          :aria-label="t('workspaceUi.renameWorkspace')" @mousedown.prevent @click.stop="startRename(entry)">
          <Icon name="action.edit" :size="11" />
        </button>
        <button type="button" class="file-list-btn del" :disabled="busy" :title="t('filesUi.unbindDesktopWorkspace')"
          :aria-label="t('filesUi.unbindDesktopWorkspace')" @click.stop="$emit('unbind', entry.id as DesktopFileDirectory)">
          <Icon name="action.delete" :size="11" />
        </button>
      </span>
    </div>
  </FileBrowserList>
</template>

<style scoped>
.desktop-location-list :is(.list-head, .list-row) { grid-template-columns: minmax(0, 1fr); }
.desktop-location-list .list-row.has-actions { grid-template-columns: minmax(0, 1fr) auto; }
.desktop-location-list .list-row {
  width: 100%;
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
}
</style>
