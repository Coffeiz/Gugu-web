<template>
  <button class="col-toggle-btn" @click="togglePmStages"
    :title="stagesExpanded ? t('projects.restoreFileArea') : t('projects.expandStageArea')">
    <Icon :name="stagesExpanded ? 'action.chevron-back' : 'action.chevron-next'" :size="13" />
  </button>

  <FileBrowserToolbar
    :class="{ 'desktop-native-toolbar': nativeWindow }"
    :data-window-drag="desktop ? '' : undefined"
    :can-paste="clipboard?.canPaste ?? false"
    :paste-count="clipboard?.count ?? 0"
    :selection-mode="pmInSelectionMode"
    :view-mode="fileViewMode"
    :show-new-folder="showNewFolder"
    :new-folder-name="newFolderName"
    :folder-loading="folderLoading"
    :sort-options="PM_SORT_OPTIONS"
    :sort-key="pmSortKey"
    :sort-dir="pmSortDir"
    @paste="pmCtxPaste"
    @toggle-selection="togglePmSelectionMode"
    @update:view-mode="value => fileViewMode = value"
    @update:show-new-folder="value => showNewFolder = value"
    @update:new-folder-name="value => newFolderName = value"
    @create-folder="createFolder"
    @sort-select="onPmSortSelect"
    @close="closeProjectModal"
  >
    <template #extra><slot /></template>
    <template #breadcrumb>
      <ProjectFileBreadcrumb
        :can-go-back="pmCanGoBack"
        :can-go-forward="pmCanGoForward"
        :folder-stack="folderStack"
        :runtime-scope="runtimeScope"
        @go-back="pmGoBack"
        @go-forward="pmGoForward"
        @navigate="pmNavigateTo"
      >
        <template v-if="desktop && $slots.root" #root><slot name="root" /></template>
      </ProjectFileBreadcrumb>
    </template>
  </FileBrowserToolbar>
</template>

<script setup lang="ts">
import Icon from '@/components/common/icons/Icon.vue'
import type { PropType } from 'vue'
import { useI18n } from 'vue-i18n'
import FileBrowserToolbar from '@/components/common/file-browser/FileBrowserToolbar.vue'
import ProjectFileBreadcrumb from '@/views/Projects/components/ProjectFileBreadcrumb.vue'

const props = defineProps({
  context: { type: Object as PropType<Record<string, any>>, required: true },
  desktop: Boolean,
  nativeWindow: Boolean,
  clipboard: { type: Object as PropType<{ canPaste: boolean; count: number }> },
})
const { t } = useI18n()
const {
  stagesExpanded, togglePmStages, pmCanGoBack, pmGoBack, pmCanGoForward, pmGoForward,
  pmNavigateTo, folderStack, pmCtxPaste, pmInSelectionMode,
  togglePmSelectionMode, fileViewMode, showNewFolder, newFolderName, folderLoading, createFolder,
  PM_SORT_OPTIONS, pmSortKey, pmSortDir, onPmSortSelect, closeProjectModal, runtimeScope,
} = props.context
</script>

<style scoped>
/* 项目编辑卡拥有自己的 toolbar host 几何；内部 control paint/尺寸仍由共享契约负责。 */
.file-browser-toolbar {
  height: 52px;
  box-sizing: border-box;
  padding: 0 12px 0 16px;
}
.desktop-native-toolbar { app-region: drag; -webkit-app-region: drag; }
.desktop-native-toolbar :deep(:is(button, input)) { app-region: no-drag; -webkit-app-region: no-drag; }
</style>
