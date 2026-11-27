<script setup lang="ts">
import { computed, onScopeDispose, ref, type PropType } from 'vue'
import { PERSONAL_WORKSPACE_ID } from '@gugu/core/agent/commands/menu'
import { useI18n } from 'vue-i18n'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import FlipChevron from '@/components/common/controls/FlipChevron.vue'
import ContextMenu from '@/components/common/overlays/ContextMenu.vue'
import Icon from '@/components/common/icons/Icon.vue'
import WorkspaceCreateDialog from '@/views/Files/components/WorkspaceCreateDialog.vue'
import { useProjectAccess, type ProjectWorkspaceBinding } from '@/api/projects'
import { errorMessage, showAppError } from '@/composables/core/useAppToast'

type DirectoryId = typeof PERSONAL_WORKSPACE_ID | `project:${number}` | ProjectWorkspaceBinding['id']
const props = defineProps({
  projectId: { type: Number, required: true },
  directoryId: { type: [String, Number] as PropType<DirectoryId>, required: true },
})
const emit = defineEmits<{ select: [directoryId: DirectoryId, name?: string] }>()
const access = useProjectAccess()
const { t } = useI18n()
const rows = ref<ProjectWorkspaceBinding[]>([])
const busy = ref(false)
const showCreate = ref(false)
const addWorkspaceOption = 'add-workspace'
const projectRoot = computed(() => `project:${props.projectId}` as const)
const workspaces = computed(() => rows.value.filter(row => row.available))
const isProjectRoot = computed(() => props.directoryId === projectRoot.value)
const selectedLabel = computed(() => props.directoryId === PERSONAL_WORKSPACE_ID ? t('filesUi.personalFiles') : rows.value.find(row => row.id === props.directoryId)?.name ?? t('filesUi.projectFiles'))
const menuAnchor = ref<HTMLElement | null>(null)
const menuOpen = ref(false)

function toggleMenu(event: MouseEvent) {
  if (!(event.currentTarget instanceof HTMLElement)) return
  menuAnchor.value = event.currentTarget
  menuOpen.value = !menuOpen.value
}

let active = true
onScopeDispose(() => { active = false })

async function refresh() {
  if (!access.listWorkspaceBindings) return
  const result = await access.listWorkspaceBindings(props.projectId)
  if (active) rows.value = result
}

async function select(value: string) {
  menuOpen.value = false
  if (busy.value) return
  if (value === addWorkspaceOption) {
    showCreate.value = true
    return
  }
  if (value === PERSONAL_WORKSPACE_ID) {
    if (props.directoryId !== PERSONAL_WORKSPACE_ID) emit('select', PERSONAL_WORKSPACE_ID, t('filesUi.personalFiles'))
    return
  }
  if (!access.selectWorkspace) return
  busy.value = true
  try {
    const row = rows.value.find(item => String(item.id) === value && item.available)
    const id: DirectoryId | undefined = value === projectRoot.value ? projectRoot.value : row?.id
    if (id === props.directoryId) return
    if (id === undefined || !active) return
    await access.selectWorkspace(props.projectId, id, row?.workspaceId)
    if (active) emit('select', id, row?.name)
  } catch (error) {
    if (active) showAppError(errorMessage(error))
  } finally {
    busy.value = false
  }
}

async function addWorkspace() {
  if (busy.value || !access.pickWorkspace) return
  busy.value = true
  let id: `desktop:${string}` | null
  try {
    id = await access.pickWorkspace()
    if (!id || !active) return
    showCreate.value = false
    await refresh()
  } catch (error) {
    if (active) showAppError(errorMessage(error))
    return
  } finally {
    busy.value = false
  }
  if (active) await select(id)
}

void refresh().then(() => {
  if (!active || busy.value) return
  const selected = rows.value.find(row => row.active)
  if (selected) emit('select', selected.id, selected.name)
}).catch(error => { if (active) showAppError(errorMessage(error)) })
</script>

<template>
  <div v-if="access.listWorkspaceBindings" class="workspace-selector" @click.stop>
    <ActionButton variant="secondary" fit :disabled="busy"
      :aria-label="t('projectWorkspaceUi.select')" :aria-expanded="menuOpen" :title="selectedLabel"
      @click.stop="toggleMenu">
      <Icon :name="isProjectRoot ? 'file.folder-chart' : 'file.folder'" size="sm" tone="inherit" />
      <span class="workspace-label">{{ selectedLabel }}</span>
      <FlipChevron :open="menuOpen" :size="9" />
    </ActionButton>
    <ContextMenu :show="menuOpen" :anchor="menuAnchor" compact @close="menuOpen = false">
      <button type="button" class="ctx-item popup-menu-item" :class="{ active: isProjectRoot }"
        @click="select(projectRoot)">
        <Icon name="file.folder-chart" size="sm" tone="inherit" />
        {{ t('filesUi.projectFiles') }}
      </button>
      <button type="button" class="ctx-item popup-menu-item" :class="{ active: directoryId === PERSONAL_WORKSPACE_ID }"
        @click="select(PERSONAL_WORKSPACE_ID)">
        <Icon name="file.folder" size="sm" tone="inherit" />
        {{ t('filesUi.personalFiles') }}
      </button>
      <template v-if="workspaces.length">
        <div class="popup-menu-sep" role="separator"></div>
        <button v-for="workspace in workspaces" :key="workspace.id" type="button"
          class="ctx-item popup-menu-item" :class="{ active: directoryId === workspace.id }"
          @click="select(String(workspace.id))">
          <Icon name="file.folder" size="sm" tone="inherit" />
          {{ workspace.name }}
        </button>
      </template>
      <template v-if="access.pickWorkspace">
        <div class="popup-menu-sep" role="separator"></div>
        <button type="button" class="ctx-item popup-menu-item" @click="select(addWorkspaceOption)">
          <Icon name="file.folder-add" size="sm" tone="inherit" />
          {{ t('filesUi.addDesktopWorkspace') }}
        </button>
      </template>
    </ContextMenu>
  </div>
  <WorkspaceCreateDialog v-if="access.pickWorkspace" local :show="showCreate" :busy="busy"
    @close="showCreate = false" @submit="addWorkspace" />
</template>

<style scoped>
.workspace-selector { flex: 0 1 auto; min-width: 0; max-width: 180px; }
.workspace-selector :deep(button) { max-width: 100%; }
.workspace-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
