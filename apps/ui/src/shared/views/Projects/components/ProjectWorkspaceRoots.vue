<script setup lang="ts">
import { computed, onScopeDispose, ref, type PropType } from 'vue'
import { useI18n } from 'vue-i18n'
import SelectPopup from '@/components/common/controls/SelectPopup.vue'
import { useProjectAccess, type ProjectWorkspaceBinding } from '@/api/projects'
import { errorMessage, showAppError } from '@/composables/core/useAppToast'

type DirectoryId = `project:${number}` | ProjectWorkspaceBinding['id']
const props = defineProps({
  projectId: { type: Number, required: true },
  directoryId: { type: [String, Number] as PropType<DirectoryId>, required: true },
})
const emit = defineEmits<{ select: [directoryId: DirectoryId, name?: string] }>()
const access = useProjectAccess()
const { t } = useI18n()
const rows = ref<ProjectWorkspaceBinding[]>([])
const busy = ref(false)
const projectRoot = computed(() => `project:${props.projectId}` as const)
const selectedLabel = computed(() => rows.value.find(row => row.id === props.directoryId)?.name)
const options = computed(() => [
  { value: projectRoot.value, label: t('filesUi.projectFiles') },
  ...rows.value.filter(row => row.available).map(row => ({ value: String(row.id), label: row.name })),
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

void refresh().then(() => {
  if (!active || busy.value) return
  const selected = rows.value.find(row => row.active)
  if (selected) emit('select', selected.id, selected.name)
}).catch(error => { if (active) showAppError(errorMessage(error)) })
</script>

<template>
  <SelectPopup v-if="access.listWorkspaceBindings" class="workspace-selector"
    :model-value="String(directoryId)" :options="options" :disabled="busy"
    :selected-label="selectedLabel" :aria-label="t('projectWorkspaceUi.select')" @update:model-value="select" />
</template>

<style scoped>
.workspace-selector { flex: 0 1 auto; min-width: 0; max-width: 180px; }
.workspace-selector :deep(.select-popup-trigger) { min-width: 0; height: var(--file-toolbar-control-height, 30px); }
</style>
