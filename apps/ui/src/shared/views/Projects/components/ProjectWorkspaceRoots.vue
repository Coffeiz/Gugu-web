<script setup lang="ts">
import { computed, onScopeDispose, ref, type PropType } from 'vue'
import { useI18n } from 'vue-i18n'
import SelectPopup from '@/components/common/controls/SelectPopup.vue'
import { useProjectAccess, type ProjectWorkspaceBinding } from '@/api/projects'
import { errorMessage, showAppError, showAppNotice } from '@/composables/core/useAppToast'

type DirectoryId = `project:${number}` | ProjectWorkspaceBinding['id']
const props = defineProps({
  projectId: { type: Number, required: true },
  directoryId: { type: String as PropType<DirectoryId>, required: true },
  native: Boolean,
})
const emit = defineEmits<{ select: [directoryId: DirectoryId, name?: string] }>()
const access = useProjectAccess()
const { t } = useI18n()
const rows = ref<ProjectWorkspaceBinding[]>([])
const busy = ref(false)
const projectRoot = computed(() => `project:${props.projectId}` as const)
const createOption = 'create-workspace'
const selectedLabel = computed(() => rows.value.find(row => row.id === props.directoryId)?.name)
const options = computed(() => [
  { value: projectRoot.value, label: t('filesUi.projectFiles') },
  ...rows.value.filter(row => row.available).map(row => ({ value: row.id, label: row.name })),
  { value: createOption, label: t('workspaceUi.createWorkspace') },
])
let active = true
onScopeDispose(() => { active = false })

async function refresh() {
  if (!access.listWorkspaceBindings) return
  const result = await access.listWorkspaceBindings(props.projectId)
  if (active) rows.value = result
}

async function select(value: string) {
  if (busy.value) return
  if (!access.selectWorkspace) return
  busy.value = true
  try {
    const row = rows.value.find(item => item.id === value && item.available)
    let id: DirectoryId | undefined = value === projectRoot.value ? projectRoot.value : row?.id
    if (value === props.directoryId) return
    if (value === createOption) {
      if (!props.native) {
        showAppNotice(t('filesUi.addDesktopWorkspaceNative'))
        return
      }
      id = (await access.pickWorkspace?.()) ?? undefined
    }
    if (!id || !active) return
    await access.selectWorkspace(props.projectId, id)
    if (!active) return
    if (id === projectRoot.value || row) emit('select', id, row?.name)
    else {
      await refresh()
      if (active) emit('select', id, rows.value.find(item => item.id === id)?.name)
    }
  } catch (error) {
    if (active) showAppError(errorMessage(error))
  } finally {
    busy.value = false
  }
}

void refresh().then(() => {
  if (!active || busy.value) return
  const selected = rows.value.find(row => row.active)
  if (selected) emit('select', selected.id, selected.name)
}).catch(error => { if (active) showAppError(errorMessage(error)) })
</script>

<template>
  <SelectPopup v-if="access.listWorkspaceBindings" class="workspace-selector"
    :model-value="directoryId" :options="options" :disabled="busy"
    :selected-label="selectedLabel" :aria-label="t('projectWorkspaceUi.select')" @update:model-value="select" />
</template>

<style scoped>
.workspace-selector { flex: 0 1 auto; min-width: 0; max-width: 180px; }
.workspace-selector :deep(.select-popup-trigger) { min-width: 0; height: var(--file-toolbar-control-height, 30px); }
</style>
