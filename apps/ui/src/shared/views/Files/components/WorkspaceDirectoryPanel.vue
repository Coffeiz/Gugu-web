<template>
  <div v-if="loading && !loaded" class="workspace-state">{{ t('workspaceUi.loadingWorkspaces') }}</div>
  <div v-else-if="error && !loaded" class="workspace-state is-error">
    <span>{{ t('workspaceUi.workspaceLoadFailed') }}</span>
    <ActionButton variant="secondary" fit @click="refresh">{{ t('common.actions.retry') }}</ActionButton>
  </div>
  <template v-else v-for="item in rootItems" :key="item.id">
    <FolderCard
      v-if="mode === 'grid'"
      :data-layout-key="`workspace:${item.id}`"
      data-layout-role="card"
      :display-name="item.name"
      :count-label="countLabel(item)"
      accent-color="var(--accent-primary)"
      role="button"
      tabindex="0"
      @click.stop="$emit('open', item)"
      @keydown.enter.self.prevent="$emit('open', item)"
    >
      <template #icon><Icon name="file.folder-chart" class="fd-big-icon" :size="92" /></template>
      <template #name>
        <RenameInput v-if="renameTarget?.id === item.id" v-model="renameName" @commit="commitRename" @cancel="closeRename" />
        <span v-else :title="item.name">{{ item.name }}</span>
      </template>
      <template #actions>
        <button v-if="!item.isDefault && !item.isSystem" class="file-card-btn" :title="t('workspaceUi.renameWorkspace')" @mousedown.prevent @click.stop="startRename(item)">
          <Icon name="action.edit" :size="11" />
        </button>
        <button v-if="!item.isDefault && !item.isSystem" class="file-card-btn del" :title="t('workspaceUi.deleteWorkspace')" @click.stop="removeWorkspace(item)">
          <Icon name="action.delete" :size="11" />
        </button>
      </template>
    </FolderCard>
    <div v-else class="list-row folder-row" role="button" tabindex="0"
      :data-layout-key="`workspace:${item.id}`" data-layout-role="card"
      @click.stop="$emit('open', item)" @keydown.enter.self.prevent="$emit('open', item)">
      <span class="lr-name-cell">
        <Icon name="file.folder-chart" class="lr-folder-icon" :size="16" />
        <span class="lr-filename" :title="item.name">
          <RenameInput v-if="renameTarget?.id === item.id" v-model="renameName" @commit="commitRename" @cancel="closeRename" />
          <template v-else>{{ item.name }}</template>
        </span>
      </span>
      <span class="lr-type-text">{{ t('workspaceUi.workspaceDirectories') }}</span>
      <span class="lr-text">—</span>
      <span class="lr-text">{{ countLabel(item) ?? '—' }}</span>
      <span class="lr-text">—</span>
      <span class="lr-actions" v-if="!item.isDefault && !item.isSystem">
        <button class="file-list-btn" :title="t('workspaceUi.renameWorkspace')" @mousedown.prevent @click.stop="startRename(item)">
          <Icon name="action.edit" :size="11" />
        </button>
        <button class="file-list-btn del" :title="t('workspaceUi.deleteWorkspace')" @click.stop="removeWorkspace(item)">
          <Icon name="action.delete" :size="11" />
        </button>
      </span>
    </div>
  </template>

  <BaseModal
    :show="showCreate"
    width="var(--confirm-dialog-width)"
    background="var(--modal-card-bg)"
    teleport-to="body"
    @close="closeCreate"
  >
    <form class="workspace-modal" @submit.prevent="createWorkspace">
      <h2>{{ t('workspaceUi.createWorkspace') }}</h2>
      <p>{{ t('workspaceUi.createWorkspaceHint') }}</p>
      <input ref="createInput" v-model="createName" class="workspace-input" :placeholder="t('workspaceUi.workspaceNamePlaceholder')" maxlength="200" autofocus />
      <p v-if="formError" class="workspace-form-error">{{ formError }}</p>
      <div class="workspace-modal-actions">
        <ActionButton variant="secondary" fit type="button" @click="closeCreate">{{ t('common.actions.cancel') }}</ActionButton>
        <ActionButton fit type="submit" :disabled="submitting || !createName.trim()">{{ submitting ? t('common.status.saving') : t('common.actions.confirm') }}</ActionButton>
      </div>
    </form>
  </BaseModal>

</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { workspaceDirectoriesApi } from '@/services/api'
import { useWorkspaceDirectories } from '@/composables/files/useWorkspaceDirectories'
import type { WorkspaceDirectory } from '@/services/api'
import BaseModal from '@/components/common/overlays/BaseModal.vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import Icon from '@/components/common/icons/Icon.vue'
import FolderCard from '@/components/common/file-browser/FolderCard.vue'
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
const createInput = ref<HTMLInputElement | null>(null)

function openCreate() {
  if (!loading.value || loaded.value) showCreate.value = true
}

defineExpose({ openCreate })

function countLabel(item: WorkspaceDirectory) {
  const count = item.isDefault ? defaultCount.value : { id: item.id, files: item.fileCount, folders: item.folderCount }
  return count?.id === item.id ? t('filesViewUi.folderContents', { files: count.files, folders: count.folders }) : undefined
}

onMounted(refresh)
watch(showCreate, value => { if (value) nextTick(() => createInput.value?.focus()) })

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
.workspace-modal { display:flex; flex-direction:column; gap:12px; padding:var(--space-lg); color:var(--text-primary); }
.workspace-modal h2 { margin:0; font:var(--font-weight-semibold) var(--font-size-lg)/var(--line-height-ui) var(--font-sans); }
/* 输入框交互口径对齐 .pm-workspace-input（ProfileWorkspacesPane）：基态声明透明
   聚焦时沿用共享输入框的高亮描边。 */
.workspace-input { box-sizing:border-box; width:100%; height:38px; padding:0 12px; color:var(--text-primary); background:var(--input-bg); border:1px solid var(--input-border); border-radius:var(--radius-xs); font:var(--font-weight-regular) var(--font-size-sm) var(--font-sans); outline:none; box-shadow:var(--input-hover-shadow), 0 0 0 0 transparent; transition:background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), box-shadow var(--motion-hover-control) var(--motion-ease-standard); }
.workspace-input:hover { border-color:var(--input-border-hover); background:var(--input-bg-hover); }
.workspace-input:focus { border-color:var(--input-border-focus); background:var(--input-bg-focus); box-shadow:var(--input-hover-shadow); }
.workspace-form-error { color:var(--danger-button-fg) !important; }
.workspace-modal-actions { display:flex; justify-content:flex-end; gap:8px; }
</style>
