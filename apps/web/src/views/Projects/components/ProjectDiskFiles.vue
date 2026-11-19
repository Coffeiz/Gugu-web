<template>
  <FileBrowserPanel class="modal-right">
    <template #toolbar>
      <ProjectFileToolbar :context="toolbarContext" :clipboard="{ canPaste, count: pasteCount }" />
    </template>

    <div ref="main" class="file-content scroll-surface" @mousedown="selection.onContainerMouseDown"
      @dragover.prevent @drop.prevent="dropFiles">
      <div v-if="selectionRect" class="project-path-selection" :style="{
        left: selectionRect.left + 'px', top: selectionRect.top + 'px',
        width: selectionRect.width + 'px', height: selectionRect.height + 'px',
      }" />
      <PathFiles ref="files" :directory-id="target.directoryId" :relative-path="target.relativePath"
        :runtime-surface-id="surfaceId" :view-mode="viewMode" :sort-key="sortKey" :sort-dir="sortDir" :reload="reload"
        :cut-paths="cutPaths" :selected-paths="selectedPaths" :preview-paths="previewPaths" :selection-mode="selectionMode"
        @open-directory="openDirectory" @sort-select="onSortSelect" @select="selection.select"
        @cut="selection.cutSelected" @renamed="selection.clearCut" />
    </div>

    <FileSelectionToolbar v-if="fileCount + folderCount > 0" path-actions
      :file-count="fileCount" :folder-count="folderCount" @cut="selection.cutSelected()" @copy="selection.copySelected"
      @download="selection.downloadSelected" @delete="selection.trashSelected" @cancel="selection.clearSelection" />
  </FileBrowserPanel>
</template>

<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, toRef, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import FileBrowserPanel from '@/components/common/file-browser/FileBrowserPanel.vue'
import ProjectFileToolbar from './ProjectFileToolbar.vue'
import FileSelectionToolbar from '@/components/common/file-browser/FileSelectionToolbar.vue'
import PathFiles from '@/views/Files/components/PathFiles.vue'
import { usePathFileSelection } from '@/composables/files/usePathFileSelection'
import { useFolderNavigation } from '@/composables/files/useFolderNavigation'
import { parseBreadcrumbSurfaceId } from '@/interaction/runtime/adapters/file/fileRuntimeAdapter'
import { useSorting } from '@/composables/shared/useSorting'
import { errorMessage, showAppError } from '@/composables/core/useAppToast'
import { pathFilesApi, type PathFileEntry, type PathFileRef } from '@/services/api'
import { runtime } from '@/interaction/runtime'
import { useRuntimeAction } from '@/interaction/runtime/vue'

const props = defineProps<{ projectId: number; workspaceAvailable: boolean; workspaceExists: boolean; stagesExpanded: boolean }>()
const emit = defineEmits<{ workspace: []; close: []; toggleStages: []; selectionChange: [active: boolean] }>()
const { t } = useI18n()
const main = ref<HTMLElement | null>(null)
const files = ref<InstanceType<typeof PathFiles> | null>(null)
const navigation = useFolderNavigation<PathFileEntry & { id: string }>()
const { folderStack } = navigation
const reload = ref(0)
const target = computed<PathFileRef>(() => ({
  directoryId: `project:${props.projectId}`, relativePath: folderStack.value.at(-1)?.relativePath ?? '',
}))
const selection = usePathFileSelection({
  target, container: main, getSelectedEntries: () => files.value?.selectedEntries() ?? [],
  reload: () => { reload.value++ },
})
const { selectionMode, selectionRect, selectedPaths, previewPaths, cutPaths, pasteCount, canPaste, fileCount, folderCount } = selection
watch(selectionMode, active => emit('selectionChange', active))
const viewMode = ref<'grid' | 'list'>('grid')
const { SORT_OPTIONS, sortKey, sortDir, onSortSelect } = useSorting('workspace-files')
const sortOptions = computed(() => SORT_OPTIONS.value.filter(({ key }) => key !== 'stage' && key !== 'createdAt'))
const showNewFolder = ref(false)
const folderName = ref('')
const creating = ref(false)

const surfaceId = `project-path:${useId()}`
const generation = runtime.surfaces.register({
  id: surfaceId, type: 'file-browser', accepts: ['file-item', 'folder-item'], layout: 'grid', element: null,
  viewport: () => main.value,
})
watch(main, element => { runtime.surfaces.setElement(surfaceId, element) }, { flush: 'post' })
onScopeDispose(() => runtime.surfaces.unregister(surfaceId, generation))
useRuntimeAction(action => {
  if (action.type !== 'move' && action.type !== 'move-group') return
  const index = parseBreadcrumbSurfaceId(surfaceId, action.toSurfaceId)
  const destination = index === -1 ? '' : index === null ? undefined : folderStack.value[index]?.relativePath
  return files.value?.handleMoveAction(action.type === 'move' ? [action.objectId] : action.objectIds, action.toSurfaceId, selection.moveInto, destination)
})

function navigate(index: number) {
  if (index === folderStack.value.length - 1) reload.value++
  else navigation.navigateTo(index)
}
function openDirectory(entry: PathFileEntry) {
  navigation.enterFolder({ ...entry, id: entry.relativePath })
}

const toolbarContext = {
  stagesExpanded: toRef(props, 'stagesExpanded'),
  togglePmStages: () => emit('toggleStages'),
  pmCanGoBack: navigation.canGoBack,
  pmCanGoForward: navigation.canGoForward,
  pmGoBack: navigation.goBack,
  pmGoForward: navigation.goForward,
  pmNavigateTo: navigate,
  folderStack,
  runtimeScope: surfaceId,
  pmCtxPaste: selection.paste,
  pmInSelectionMode: selectionMode,
  togglePmSelectionMode: selection.toggleSelection,
  fileViewMode: viewMode,
  showNewFolder,
  newFolderName: folderName,
  folderLoading: creating,
  createFolder,
  PM_SORT_OPTIONS: sortOptions,
  pmSortKey: sortKey,
  pmSortDir: sortDir,
  onPmSortSelect: onSortSelect,
  workspaceAvailable: toRef(props, 'workspaceAvailable'),
  workspaceExists: toRef(props, 'workspaceExists'),
  toggleWorkspace: () => emit('workspace'),
  closeProjectModal: () => emit('close'),
}

function dropFiles(event: DragEvent) { if (event.dataTransfer?.types.includes('Files')) void files.value?.handleDrop(event) }

async function createFolder() {
  const name = folderName.value.trim()
  if (!name || creating.value) return
  if (/[\/\\]/.test(name)) { showAppError(t('projects.invalidName')); return }
  const { directoryId, relativePath } = target.value
  creating.value = true
  try {
    await pathFilesApi.createFolder({ directoryId, relativePath: [relativePath, name].filter(Boolean).join('/') })
    folderName.value = ''
    showNewFolder.value = false
    reload.value++
  } catch (error) {
    showAppError(errorMessage(error))
  } finally {
    creating.value = false
  }
}

function onKeyDown(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey) || (event.target as Element | null)?.closest?.('input, textarea, [contenteditable]')) return
  if (event.key === 'c' && selectedPaths.value.size) {
    event.preventDefault(); event.stopImmediatePropagation(); selection.copySelected()
  } else if (event.key === 'x' && selectedPaths.value.size) {
    event.preventDefault(); event.stopImmediatePropagation(); selection.cutSelected()
  } else if (event.key === 'v' && canPaste.value) {
    event.preventDefault(); event.stopImmediatePropagation(); void selection.paste()
  }
}
onMounted(() => document.addEventListener('keydown', onKeyDown, true))
onScopeDispose(() => document.removeEventListener('keydown', onKeyDown, true))
</script>

<style scoped>
.modal-right {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  position: relative;
  background: var(--panel-bg);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.98);
}
.file-content {
  flex: 1;
  overflow-y: auto;
  padding: 14px;
  user-select: none;
  position: relative;
  isolation: isolate;
}
.modal-right :deep(.col-toggle-btn) {
  position: absolute;
  left: -7px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 12;
  width: 12px;
  height: 48px;
  padding: 0;
  border-radius: 7px;
  border: 1px solid var(--control-border);
  background: var(--surface-card-solid);
  display: grid;
  place-items: center;
  color: var(--text-secondary);
  cursor: pointer;
}
.modal-right :deep(.col-toggle-btn:hover) { color: var(--action-primary); }
.file-content :deep(.file-grid) { grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); }
.project-path-selection {
  position: absolute;
  pointer-events: none;
  z-index: 10;
  border: 1px solid var(--action-primary);
  background: var(--action-soft);
}
</style>
