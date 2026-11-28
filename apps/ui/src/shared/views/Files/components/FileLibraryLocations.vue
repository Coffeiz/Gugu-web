<script setup lang="ts">
import { ref, watch, type PropType } from 'vue'
import RenameInput from '@/components/common/file-browser/RenameInput.vue'
import { i18n } from '@/i18n'
import FileLibraryFolderItem from './FileLibraryFolderItem.vue'
import FileBrowserGrid from '@/components/common/file-browser/FileBrowserGrid.vue'
import FileBrowserList from '@/components/common/file-browser/FileBrowserList.vue'
import type { FolderCard as FolderCardMeta } from '@/utils/filesNav'
import Icon from '@/components/common/icons/Icon.vue'

const props = defineProps({
  entries: { type: Array as PropType<FolderCardMeta[]>, required: true },
  viewMode: { type: String as PropType<'grid' | 'list'>, required: true },
  layoutCollection: { type: String, required: true },
  canManage: { type: Function as PropType<(entry: FolderCardMeta) => boolean>, required: true },
  busy: Boolean,
  renameWorkspace: { type: Function as PropType<(id: string, name: string) => Promise<unknown>>, required: true },
})
defineEmits<{ open: [location: FolderCardMeta]; unbind: [id: string] }>()
const renameId = ref<string>()
const renameName = ref('')
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
  if (await props.renameWorkspace(entry.id, name)) closeRename()
}
watch(() => props.viewMode, closeRename)
const t = i18n.global.t
const headers = ['name', 'type', 'projectStage', 'size', 'date'] as const
</script>

<template>
  <component :is="viewMode === 'grid' ? FileBrowserGrid : FileBrowserList" :layout-collection="layoutCollection">
    <div v-if="viewMode === 'list'" class="list-head">
      <span v-for="header in headers" :key="header">{{ t(`filesViewUi.${header}`) }}</span>
      <span />
    </div>
    <FileLibraryFolderItem v-for="entry in entries" :key="entry.id"
      :item="entry" :mode="viewMode" :layout-key="entry.id" @open="$emit('open', entry)">
      <template v-if="canManage(entry)" #name>
        <RenameInput v-if="renameId === entry.id" v-model="renameName" @commit="commitRename(entry)" @cancel="closeRename" />
        <span v-else :title="entry.displayName">{{ entry.displayName }}</span>
      </template>
      <template v-if="canManage(entry)" #actions>
        <button type="button" :class="viewMode === 'grid' ? 'file-card-btn' : 'file-list-btn'" :disabled="busy"
          :title="t('workspaceUi.renameWorkspace')" :aria-label="t('workspaceUi.renameWorkspace')"
          @mousedown.prevent @click.stop="startRename(entry)">
          <Icon name="action.edit" :size="11" />
        </button>
        <button type="button" :class="[viewMode === 'grid' ? 'file-card-btn' : 'file-list-btn', 'del']" :disabled="busy"
          :title="t('filesUi.unbindDesktopWorkspace')" :aria-label="t('filesUi.unbindDesktopWorkspace')"
          @click.stop="$emit('unbind', entry.id)">
          <Icon name="action.delete" :size="11" />
        </button>
      </template>
    </FileLibraryFolderItem>
  </component>
</template>
