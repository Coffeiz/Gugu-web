<template>
  <FileBrowserPanel class="modal-right" :class="{ 'desktop-project-files': desktop }">
    <template #toolbar>
      <ProjectFileToolbar :desktop="desktop" :native-window="nativeWindow" :context="toolbarContext" :clipboard="{ canPaste, count: pasteCount }">
        <template #root>{{ rootName || t('sharedUi.projectFiles') }}</template>
        <ProjectWorkspaceRoots :project-id="projectId" :directory-id="target.directoryId"
          @select="selectProjectRoot" />
        <DesktopRevealButton v-if="desktop && typeof target.directoryId === 'string'" :directory-id="target.directoryId" :path="target.relativePath" />
      </ProjectFileToolbar>
    </template>

    <div ref="main" class="file-content scroll-surface" @mousedown="selection.onContainerMouseDown"
      @dragover.prevent @drop.prevent="dropFiles">
      <div v-if="selectionRect" class="project-path-selection" :style="{
        left: selectionRect.left + 'px', top: selectionRect.top + 'px',
        width: selectionRect.width + 'px', height: selectionRect.height + 'px',
      }" />
      <PathFiles ref="files" :directory-id="target.directoryId" :relative-path="target.relativePath"
        :native-file-drag="desktop"
        :runtime-surface-id="surfaceId" :view-mode="viewMode" :sort-key="sortKey" :sort-dir="sortDir" :reload="reload"
        :cut-paths="cutPaths" :selected-paths="selectedPaths" :preview-paths="previewPaths" :selection-mode="selectionMode"
        @open-directory="openDirectory" @sort-select="onSortSelect" @select="selection.select"
        @cut="selection.cutSelected" @trash="selection.trashEntry" @renamed="selection.clearCut" />
    </div>

    <FileSelectionToolbar v-if="fileCount + folderCount > 0" path-actions
      :file-count="fileCount" :folder-count="folderCount" @cut="selection.cutSelected()" @copy="selection.copySelected"
      @download="selection.downloadSelected" @delete="selection.trashSelected" @cancel="selection.clearSelection" />
  </FileBrowserPanel>
</template>

<script setup lang="ts">
import { useFileViewMode } from '@/composables/files/useFileViewMode'
import { computed, onMounted, onScopeDispose, ref, toRef, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import DesktopRevealButton from '@/components/common/file-browser/DesktopRevealButton.vue'
import FileBrowserPanel from '@/components/common/file-browser/FileBrowserPanel.vue'
import ProjectFileToolbar from './ProjectFileToolbar.vue'
import ProjectWorkspaceRoots from './ProjectWorkspaceRoots.vue'
import FileSelectionToolbar from '@/components/common/file-browser/FileSelectionToolbar.vue'
import PathFiles from '@/views/Files/components/PathFiles.vue'
import { hasShortcutOverlay } from '@/interaction/keyboardShortcuts'
import { usePathFileSelection } from '@/composables/files/usePathFileSelection'
import { useFolderNavigation } from '@/composables/files/useFolderNavigation'
import { parseBreadcrumbSurfaceId } from '@/interaction/runtime/adapters/file/fileRuntimeAdapter'
import { useSorting } from '@/composables/shared/useSorting'
import { errorMessage, showAppError } from '@/composables/core/useAppToast'
import { type PathFileEntry } from '@/services/api'
import { usePathFileAccess } from '@/services/pathFileAccess'
import { runtime } from '@/interaction/runtime'
import { useRuntimeAction } from '@/interaction/runtime/vue'

const pathFilesApi = usePathFileAccess()

const props = defineProps<{ projectId: number; projectDirectoryKey?: string; desktop?: boolean; nativeWindow?: boolean; stagesExpanded: boolean }>()
const emit = defineEmits<{ close: []; toggleStages: []; selectionChange: [active: boolean] }>()
const { t } = useI18n()
const main = ref<HTMLElement | null>(null)
const files = ref<InstanceType<typeof PathFiles> | null>(null)
const navigation = useFolderNavigation<PathFileEntry & { id: string }>({})
const { folderStack } = navigation
const reload = ref(0)
const projectRoot = `project:${props.projectId}` as const
const directoryId = ref<typeof projectRoot | `desktop:${string}` | number>(projectRoot)
const target = computed(() => ({
  directoryId: directoryId.value, relativePath: folderStack.value.at(-1)?.relativePath ?? '',
}))
const selection = usePathFileSelection({
  target, container: main, getEntries: () => files.value?.selectableEntries() ?? [],
  getSelectedEntries: () => files.value?.selectedEntries() ?? [],
  reload: () => { reload.value++ },
})
const { selectionMode, selectionRect, selectedPaths, previewPaths, cutPaths, pasteCount, canPaste, fileCount, folderCount } = selection
const rootName = ref<string>()
function selectProjectRoot(id: typeof directoryId.value, name?: string) {
  rootName.value = name
  if (id === directoryId.value) { navigate(-1); return }
  navigation.reset()
  selection.clearSelection()
  selection.clearCut()
  directoryId.value = id
}
watch(selectionMode, active => emit('selectionChange', active))
watch(() => props.projectDirectoryKey, () => { reload.value++ })
const viewMode = useFileViewMode('project-editor')
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
  const target = event.target
  const panel = main.value
  if (!panel || document.querySelector('.confirm-dialog')) return
  const projectOverlay = panel.closest<HTMLElement>('.bm-center')
  if (projectOverlay) {
    if (target instanceof Element && target !== document.body && !projectOverlay.contains(target)) return
    if (Array.from(document.querySelectorAll<HTMLElement>('.bm-center:not(.bm-leave-active)'))
      .some(overlay => Number(overlay.style.zIndex) > Number(projectOverlay.style.zIndex))) return
  } else if (hasShortcutOverlay(target)) return
  selection.handleShortcut(event)
}
onMounted(() => document.addEventListener('keydown', onKeyDown))
onScopeDispose(() => document.removeEventListener('keydown', onKeyDown))
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
.desktop-project-files { box-shadow: none; }
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
.file-content :deep(.file-grid) { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
.desktop-project-files .file-content :deep(.file-grid) {
  grid-template-columns: repeat(auto-fill, minmax(140px, 140px));
  justify-content: start;
}
.project-path-selection {
  position: absolute;
  pointer-events: none;
  z-index: 10;
  border: 1px solid var(--action-primary);
  background: var(--action-soft);
}
</style>
