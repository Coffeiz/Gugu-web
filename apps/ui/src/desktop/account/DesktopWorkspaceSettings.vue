<script setup lang="ts">
import { ref } from 'vue'
import { i18n } from '@/i18n'
import SelectPopup from '@/components/common/controls/SelectPopup.vue'
import { getDesktopFileOpenPreference, setDesktopFileOpenPreference } from '../files/fileOpen'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import { useDesktopWorkspaces } from '../files/useDesktopWorkspaces'
import { errorMessage, showAppError, showAppNotice } from '@/composables/core/useAppToast'

const t = i18n.global.t
const { native, busy, options, pick } = useDesktopWorkspaces()
const savingFileOpenPreference = ref(false)
const fileOpenPreference = ref(getDesktopFileOpenPreference())
const fileOpenOptions = [
  { value: 'preview', label: t('filesUi.preferGuguPreview') },
  { value: 'system', label: t('filesUi.openInSystem') },
]

async function updateFileOpenPreference(value: string) {
  if (savingFileOpenPreference.value || (value !== 'preview' && value !== 'system')) return
  savingFileOpenPreference.value = true
  try {
    await setDesktopFileOpenPreference(value)
    fileOpenPreference.value = value
  } catch (error) {
    showAppError(errorMessage(error))
  } finally {
    savingFileOpenPreference.value = false
  }
}

function relink(id: Parameters<typeof pick>[0]) {
  if (native) void pick(id)
  else showAppNotice(t('filesUi.relinkDesktopWorkspaceNative'))
}
</script>

<template>
  <section class="pm-section">
    <h3 class="pm-section-label">{{ t('filesUi.desktopFileSettings') }}</h3>
    <div class="pm-field-row">
      <span class="pm-field-name">{{ t('filesUi.desktopFileOpenPreference') }}</span>
      <SelectPopup :model-value="fileOpenPreference" :options="fileOpenOptions" :disabled="!native || savingFileOpenPreference"
        :aria-label="t('filesUi.desktopFileOpenPreference')" @update:model-value="updateFileOpenPreference" />
    </div>
  </section>
  <div class="pm-sep"></div>
  <section class="pm-section">
    <h3 class="pm-section-label">{{ t('profileWorkspacesUi.workspaceManagement') }}</h3>
    <div v-for="workspace in options" :key="workspace.value" class="pm-field-row">
      <span class="pm-field-name" :title="workspace.label">{{ workspace.label }}</span>
      <ActionButton fit variant="secondary" :disabled="busy" @click="relink(workspace.value)">
        {{ t('filesUi.relinkDesktopWorkspace') }}
      </ActionButton>
    </div>
  </section>
</template>

<style scoped>
.pm-field-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
