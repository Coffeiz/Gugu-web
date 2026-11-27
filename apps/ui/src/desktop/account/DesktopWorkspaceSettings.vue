<script setup lang="ts">
import { i18n } from '@/i18n'
import Icon from '@/components/common/icons/Icon.vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import { useDesktopWorkspaces } from '../files/useDesktopWorkspaces'
import { showAppNotice } from '@/composables/core/useAppToast'

const t = i18n.global.t
const { native, busy, options, pick } = useDesktopWorkspaces()
function relink(id: Parameters<typeof pick>[0]) {
  if (native) void pick(id)
  else showAppNotice(t('filesUi.relinkDesktopWorkspaceNative'))
}
</script>

<template>
  <section class="pm-section">
    <h3 class="pm-section-label">{{ t('profileWorkspacesUi.workspaceManagement') }}</h3>
    <div class="pm-workspace-list">
      <div v-for="workspace in options" :key="workspace.value" class="pm-workspace-card">
        <div class="pm-workspace-title-row">
          <Icon name="admin.folder" size="sm" tone="inherit" />
          <span class="pm-workspace-name" :title="workspace.label">{{ workspace.label }}</span>
        </div>
        <ActionButton fit variant="secondary" :disabled="busy" @click="relink(workspace.value)">
          {{ t('filesUi.relinkDesktopWorkspace') }}
        </ActionButton>
      </div>
    </div>
  </section>
</template>

<style scoped>
.pm-workspace-title-row :deep(svg) { flex-shrink: 0; }
</style>
