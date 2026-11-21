<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import FileBrowserToolbar from '@/components/common/file-browser/FileBrowserToolbar.vue'

defineProps({ nativeWindow: Boolean, shell: Boolean })
defineEmits<{ close: [] }>()
const { t } = useI18n()
</script>

<template>
  <section class="desktop-project-files panel-right" :class="shell ? 'is-shell' : 'modal-right'">
    <FileBrowserToolbar class="desktop-files-toolbar" :class="{ 'is-native': nativeWindow }"
      data-window-drag :show-selection="false" :show-view-toggle="false"
      :show-new-folder-button="false" :show-sort="false" @close="$emit('close')">
      <template #breadcrumb>{{ t('sharedUi.projectFiles') }}</template>
    </FileBrowserToolbar>
    <div class="desktop-files-content">
      <slot><p>{{ t('projects.desktopFilesUnavailable') }}</p></slot>
    </div>
  </section>
</template>

<style scoped>
.desktop-project-files {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  color: var(--content-secondary);
}
.desktop-project-files.is-shell { background: var(--desktop-l0-surface); }
.desktop-files-toolbar { height: 52px; box-sizing: border-box; padding: 0 12px 0 16px; cursor: grab; }
.desktop-files-toolbar.is-native { app-region: drag; -webkit-app-region: drag; cursor: default; }
.desktop-files-toolbar.is-native :deep(button) { app-region: no-drag; -webkit-app-region: no-drag; }
.desktop-files-toolbar :deep(.breadcrumb-viewport) { cursor: inherit; font-size: 12px; }
.desktop-files-content { flex: 1; display: grid; place-items: center; padding: var(--space-md); text-align: center; }
</style>
