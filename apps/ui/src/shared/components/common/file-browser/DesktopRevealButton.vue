<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { PropType } from 'vue'
import type { DesktopFileDirectory } from '@gugu/core/desktop'
import { useFileOpenAccess } from '@/services/fileOpenAccess'
import { errorMessage, showAppError, showAppNotice } from '@/composables/core/useAppToast'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import Icon from '@/components/common/icons/Icon.vue'

const props = defineProps({
  directoryId: { type: String as PropType<DesktopFileDirectory>, required: true },
  path: { type: String, default: '' },
})
const { t } = useI18n()
const revealLocalEntry = useFileOpenAccess()?.revealLocalEntry

async function reveal() {
  if (!revealLocalEntry) {
    showAppNotice(t('filesUi.revealDesktopFileNative'))
    return
  }
  try {
    await revealLocalEntry(props.directoryId, props.path)
  } catch (error) {
    showAppError(errorMessage(error))
  }
}
</script>

<template>
  <ActionButton fit variant="secondary" class="file-toolbar-icon-button"
    :aria-label="t('filesUi.revealDesktopFile')" :title="t('filesUi.revealDesktopFile')" @click.stop="reveal">
    <Icon name="file.folder-open" :size="13" />
  </ActionButton>
</template>
