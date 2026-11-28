<template>
  <div v-if="loading && !loaded" class="workspace-state">{{ t('workspaceUi.loadingWorkspaces') }}</div>
  <div v-else-if="error && !loaded" class="workspace-state is-error">
    <span>{{ t('workspaceUi.workspaceLoadFailed') }}</span>
    <ActionButton variant="secondary" fit @click="refresh">{{ t('common.actions.retry') }}</ActionButton>
  </div>
  <template v-else v-for="item in rootItems" :key="item.id">
    <FileLibraryFolderItem :item="folderItem(item)" :mode="mode"
      :layout-key="`workspace:${item.id}`" @open="$emit('open', item)">
      <template #name>
        <RenameInput v-if="renameTarget?.id === item.id" v-model="renameName" @commit="commitRename" @cancel="closeRename" />
        <span v-else :title="item.name">{{ item.name }}</span>
      </template>
      <template v-if="!item.isDefault && !item.isSystem" #actions>
        <button type="button" :class="mode === 'grid' ? 'file-card-btn' : 'file-list-btn'" :title="t('workspaceUi.renameWorkspace')" @mousedown.prevent @click.stop="startRename(item)">
          <Icon name="action.edit" :size="11" />
        </button>
        <button type="button" :class="[mode === 'grid' ? 'file-card-btn' : 'file-list-btn', 'del']" :title="t('workspaceUi.deleteWorkspace')" @click.stop="removeWorkspace(item)">
          <Icon name="action.delete" :size="11" />
        </button>
      </template>
    </FileLibraryFolderItem>
  </template>

  <WorkspaceCreateDialog v-model:name="createName" :show="showCreate" :busy="submitting"
    :error="formError" @close="closeCreate" @submit="createWorkspace" />
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { workspaceDirectoriesApi } from '@/services/api'
import { useWorkspaceDirectories } from '@/composables/files/useWorkspaceDirectories'
import type { WorkspaceDirectory } from '@/services/api'
import WorkspaceCreateDialog from './WorkspaceCreateDialog.vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import Icon from '@/components/common/icons/Icon.vue'
import FileLibraryFolderItem from './FileLibraryFolderItem.vue'
import RenameInput from '@/components/common/file-browser/RenameInput.vue'

defineProps<{ mode: 'grid' | 'list' }>()
defineEmits<{ open: [item: WorkspaceDirectory] }>()
const { t } = useI18n()
const { items, loading, loaded, error, defaultCount, refresh, create, rename, remove } = useWorkspaceDirectories()
const rootItems = computed(() => [...items.value].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.id - b.id))
const showCreate = ref(false)
const createName = ref('')
const renameTarget = ref<WorkspaceDirectory | null>(null)
const renameName = ref('')
const submitting = ref(false)
const formError = ref('')

function openCreate() {
  if (!loading.value || loaded.value) showCreate.value = true
}

defineExpose({ openCreate })

function folderItem(item: WorkspaceDirectory) {
  const count = item.isDefault ? defaultCount.value : { id: item.id, files: item.fileCount, folders: item.folderCount }
  return {
    id: String(item.id), type: 'workspace', displayName: item.name, count: null,
    fileCount: count?.id === item.id ? count.files : null,
    folderCount: count?.id === item.id ? count.folders : null,
  }
}

onMounted(refresh)

function closeCreate() { showCreate.value = false; createName.value = ''; formError.value = '' }
function closeRename() { renameTarget.value = null; renameName.value = ''; formError.value = '' }
function startRename(item: WorkspaceDirectory) {
  if (item.isDefault || item.isSystem) return
  renameTarget.value = item
  renameName.value = item.name
  formError.value = ''
}

async function createWorkspace() {
  const name = createName.value.trim()
  if (!name) return
  submitting.value = true; formError.value = ''
  try { await create(name); closeCreate() } catch (cause) { formError.value = cause instanceof Error ? cause.message : t('workspaceUi.workspaceCreateFailed') } finally { submitting.value = false }
}

async function commitRename() {
  const target = renameTarget.value
  const name = renameName.value.trim()
  if (!target || !name) return
  submitting.value = true; formError.value = ''
  try { await rename(target, name); closeRename() } catch (cause) { formError.value = cause instanceof Error ? cause.message : t('workspaceUi.workspaceRenameFailed') } finally { submitting.value = false }
}

async function removeWorkspace(item: WorkspaceDirectory) {
  let preview: WorkspaceDirectory
  try {
    preview = await workspaceDirectoriesApi.previewDelete(item.id)
  } catch (cause) {
    formError.value = cause instanceof Error ? cause.message : t('workspaceUi.workspaceDeleteFailed')
    return
  }
  const confirmed = await confirmDialog({
    title: t('workspaceUi.deleteWorkspaceTitle'),
    message: t('workspaceUi.deleteWorkspaceMessage', { name: item.name, files: preview.fileCount, folders: preview.folderCount, sessions: preview.boundSessionCount, tasks: preview.boundTaskCount }),
    tone: 'danger',
    confirmText: t('workspaceUi.deleteWorkspace'),
  })
  if (!confirmed) return
  try { await remove(item) } catch (cause) { formError.value = cause instanceof Error ? cause.message : t('workspaceUi.workspaceDeleteFailed') }
}
</script>

<style scoped>
.workspace-state { display:flex; align-items:center; gap:10px; grid-column:1 / -1; padding:8px 0; color:var(--text-secondary); font:var(--font-weight-regular) var(--font-size-sm)/var(--line-height-body) var(--font-sans); }
.workspace-state.is-error { color:var(--danger-button-fg); }
</style>
