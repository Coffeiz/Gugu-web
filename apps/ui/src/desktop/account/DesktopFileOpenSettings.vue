<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import SelectPopup from '@/components/common/controls/SelectPopup.vue'
import { errorMessage, showAppError } from '@/composables/core/useAppToast'
import { nativeDesktopBridge } from '../bridge/bridge'
import { getDesktopFileOpenPreference, setDesktopFileOpenPreference } from '../files/fileOpen'

const { t } = useI18n()
const native = Boolean(nativeDesktopBridge())
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
</template>
