<template>
  <ContextMenu :show="!!position" :x="position?.x" :y="position?.y" @close="$emit('close')">
    <button v-for="status in statuses" :key="status" type="button" class="popup-menu-item"
      :disabled="busy || project.status === status" @click="run(status)">
      <span class="project-status-dot" :style="{ background: PROJECT_STATUS_COLORS[status] }" aria-hidden="true"></span>
      {{ t(statusLabels[status]) }}
      <Icon v-if="project.status === status" name="status.success" :size="14" />
    </button>
    <div class="popup-menu-sep" role="separator"></div>
    <button type="button" class="popup-menu-item" :disabled="busy" @click="run('archive')">
      <Icon name="action.archive" :size="14" />{{ t('projects.archive') }}
    </button>
    <button type="button" class="popup-menu-item danger" :disabled="busy" @click="run('delete')">
      <Icon name="action.delete" :size="14" />{{ t('common.actions.delete') }}
    </button>
  </ContextMenu>
</template>

<script setup lang="ts">
import { PROJECT_STATUS_COLORS } from '@/utils/projectColors'
import { ref, type PropType } from 'vue'
import { useI18n } from 'vue-i18n'
import { useProjectAccess } from '@/api/projects'
import Icon from '@/components/common/icons/Icon.vue'
import ContextMenu from '@/components/common/overlays/ContextMenu.vue'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { errorMessage, showAppError } from '@/composables/core/useAppToast'
import { useProjectStore } from '@/stores/projects'
import type { Project } from '@/types/project'

const props = defineProps({
  project: { type: Object as PropType<Project>, required: true },
  position: Object as PropType<{ x: number; y: number } | null>,
})
const emit = defineEmits(['close'])
const { t } = useI18n()
const desktop = useProjectAccess().storesProjectsLocally
const store = useProjectStore()
const statuses = ['pending', 'active', 'done'] as const
const statusLabels = { pending: 'projects.notStarted', active: 'projects.inProgress', done: 'projects.done' }
const busy = ref(false)

async function run(action: typeof statuses[number] | 'archive' | 'delete') {
  if (busy.value) return
  const { id, name } = props.project
  emit('close')
  busy.value = true
  try {
    if (action === 'delete') {
      if (!await confirmDialog({
        title: t('projects.deleteTitle'),
        message: t(desktop ? 'projects.desktopTrashMessage' : 'projects.deleteContentsMessage', { name }),
        tone: 'danger',
        confirmText: t('projects.deleteConfirm'),
      })) return
      await store.deleteProject(id)
    } else if (action === 'archive') {
      await store.archiveProject(id)
    } else {
      await store.moveProject(id, action)
    }
  } catch (error) {
    showAppError(errorMessage(error))
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.project-status-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
</style>
