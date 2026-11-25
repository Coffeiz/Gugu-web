<script setup lang="ts">
import { useFileViewMode } from '@/composables/files/useFileViewMode'
import { computed, onMounted, onScopeDispose, ref, useId, watch } from 'vue'
import { i18n } from '@/i18n'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import FileBrowserPanel from '@/components/common/file-browser/FileBrowserPanel.vue'
import FileSelectionToolbar from '@/components/common/file-browser/FileSelectionToolbar.vue'
import FileBrowserBreadcrumb from '@/components/common/file-browser/FileBrowserBreadcrumb.vue'
import RuntimeBreadcrumbTarget from '@/components/common/file-browser/RuntimeBreadcrumbTarget.vue'
import DesktopRevealButton from '@/components/common/file-browser/DesktopRevealButton.vue'
import FileBrowserHistory from '@/components/common/file-browser/FileBrowserHistory.vue'
import SkeletonGate from '@/components/common/feedback/skeleton/SkeletonGate.vue'
import PageSkeleton from '@/components/common/feedback/skeleton/PageSkeleton.vue'
import type { FolderCard as FolderCardMeta } from '@/utils/filesNav'
import { projectDirectoryFolders } from '@/utils/projectFolderCards'
import { projectStatusLabelKey } from '@/utils/projectStages'
import { useUiStore } from '@/stores/ui'
import { useProjectStore } from '@/stores/projects'
import type { DesktopFileDirectory, DesktopProjectDetails } from '@gugu/core/desktop'
import FileLibraryLocations from '@/views/Files/components/FileLibraryLocations.vue'
import WorkspaceCreateDialog from '@/views/Files/components/WorkspaceCreateDialog.vue'
import Icon from '@/components/common/icons/Icon.vue'
import { useFolderNavigation } from '@/composables/files/useFolderNavigation'
import { hasShortcutOverlay } from '@/interaction/keyboardShortcuts'
import { usePathFileSelection } from '@/composables/files/usePathFileSelection'
import { useSorting } from '@/composables/shared/useSorting'
import { errorMessage, showAppError, showAppNotice } from '@/composables/core/useAppToast'
import { desktopData } from '@desktop/bridge/bridge'
import { runtime } from '@/interaction/runtime'
import { useRuntimeAction } from '@/interaction/runtime/vue'
import { breadcrumbSurfaceId, parseBreadcrumbSurfaceId } from '@/interaction/runtime/adapters/file/fileRuntimeAdapter'
import { type PathFileEntry, type PathFileRef } from '@/services/api'
import { usePathFileAccess } from '@/services/pathFileAccess'
import { desktopWorkspaceRelinked, useDesktopWorkspaces } from './useDesktopWorkspaces'
import PathFiles from '@/views/Files/components/PathFiles.vue'

const pathFilesApi = usePathFileAccess()

const t = i18n.global.t
const { native, busy, options, pick, rename, remove } = useDesktopWorkspaces()
const files = ref<InstanceType<typeof PathFiles> | null>(null)
const main = ref<HTMLElement | null>(null)
const reload = ref(0)
function refreshFiles() { reload.value++ }
onMounted(() => window.addEventListener('focus', refreshFiles))
onScopeDispose(() => window.removeEventListener('focus', refreshFiles))
const viewMode = useFileViewMode('library')
const showNewFolder = ref(false)
const folderName = ref('')
const creating = ref(false)
type Location = { id: string; name: string }
type Segment = Location & { folder?: FolderCardMeta; target?: Omit<PathFileRef, 'directoryId'> & { directoryId: DesktopFileDirectory } }
const projectsGroup = 'projects'
const nav = useFolderNavigation<Segment>({})
const { folderStack: breadcrumbs, canGoBack, canGoForward } = nav
const current = computed(() => breadcrumbs.value.at(-1))
const target = computed(() => current.value?.target ?? null)
const directoryId = computed(() => target.value?.directoryId)
const rootCounts = ref<Record<string, { fileCount: number; folderCount: number }>>({})
watch([options, current, reload], async ([locations, location], _previous, onCleanup) => {
  if (location) return
  let cancelled = false
  onCleanup(() => { cancelled = true })
  const counts = await Promise.allSettled(locations.map(async ({ value }) => {
    const entries = await pathFilesApi.entries(value)
    const folderCount = entries.filter(entry => entry.kind === 'directory').length
    return [value, { fileCount: entries.length - folderCount, folderCount }] as const
  }))
  if (!cancelled) rootCounts.value = Object.fromEntries(counts.flatMap(result => result.status === 'fulfilled' ? [result.value] : []))
}, { immediate: true })
const rootLocations = computed<FolderCardMeta[]>(() => [
  options.value[0]!,
  { value: projectsGroup, label: t('filesUi.projectFiles') },
  ...options.value.slice(1),
].map(({ value, label }) => ({ id: value, displayName: label, type: value.startsWith('desktop:') ? 'workspace' : value, count: null, ...rootCounts.value[value] })))
const projectStore = useProjectStore()
const projects = ref<DesktopProjectDetails[]>([])
const projectsPending = ref(false)
const projectsError = ref('')
const isProjects = computed(() => breadcrumbs.value[0]?.id === projectsGroup)
const visibleLocations = computed(() => {
  const folder = current.value?.folder
  if (!folder || !isProjects.value) return rootLocations.value
  const columns = projectStore.kanbanColumns.map(({ key }) => ({ key, label: t(projectStatusLabelKey(key)) }))
  return projectDirectoryFolders(projects.value, folder, columns)
})

async function loadProjects() {
  if (projectsPending.value) return
  projectsPending.value = true
  projectsError.value = ''
  try {
    const groups = await Promise.all([desktopData.projectBoard('active'), desktopData.projectBoard('archived')])
    projects.value = groups.flat()
  } catch (error) {
    projectsError.value = errorMessage(error)
  } finally {
    projectsPending.value = false
  }
}
watch(isProjects, active => { if (active) void loadProjects() })
const selection = usePathFileSelection({
  target, container: main, getEntries: () => files.value?.selectableEntries() ?? [],
  getSelectedEntries: () => files.value?.selectedEntries() ?? [],
  reload: () => { reload.value++ },
})
watch(directoryId, () => {
  selection.clearSelection()
  selection.clearCut()
  showNewFolder.value = false
  folderName.value = ''
}, { flush: 'sync' })
function onFileShortcut(event: KeyboardEvent) {
  if (!hasShortcutOverlay(event.target)) selection.handleShortcut(event)
}
onMounted(() => document.addEventListener('keydown', onFileShortcut))
onScopeDispose(() => document.removeEventListener('keydown', onFileShortcut))

const { selectionMode, selectionRect, selectedPaths, previewPaths, cutPaths, pasteCount, canPaste, fileCount, folderCount } = selection
const { SORT_OPTIONS, sortKey, sortDir, onSortSelect } = useSorting('workspace-files')
const sortOptions = computed(() => SORT_OPTIONS.value.filter(({ key }) => key !== 'stage' && key !== 'createdAt'))

const surfaceId = `desktop-files:${useId()}`
const generation = runtime.surfaces.register({
  id: surfaceId, type: 'file-browser', accepts: ['file-item', 'folder-item'], layout: 'grid', element: null,
  viewport: () => main.value,
})
watch(main, element => { runtime.surfaces.setElement(surfaceId, element) }, { flush: 'post' })
onScopeDispose(() => runtime.surfaces.unregister(surfaceId, generation))

function breadcrumbDestination(index: number) {
  const segment = breadcrumbs.value[index]
  const destination = segment?.target
  if (segment !== current.value && destination && destination.directoryId === target.value?.directoryId)
    return destination.relativePath
}

useRuntimeAction(action => {
  if (action.type !== 'move' && action.type !== 'move-group') return
  const index = parseBreadcrumbSurfaceId(surfaceId, action.toSurfaceId)
  const destination = index === null ? undefined : breadcrumbDestination(index)
  if (index !== null && destination === undefined) return
  const objectIds = action.type === 'move' ? [action.objectId] : action.objectIds
  return files.value?.handleMoveAction(objectIds, action.toSurfaceId, selection.moveInto, destination)
})

function openLocation(folder: FolderCardMeta) {
  const { id, displayName: name, type, projectId } = folder
  if (type === 'project' && projectId != null) {
    nav.enterFolder({ id, name, folder, target: { directoryId: `project:${projectId}`, relativePath: '' } })
  } else if (id === 'personal' || id.startsWith('desktop:')) {
    nav.enterFolder({ id, name, folder, target: { directoryId: id as DesktopFileDirectory, relativePath: '' } })
  } else {
    nav.enterFolder({ id, name, folder })
  }
}

const uiStore = useUiStore()
watch(() => uiStore.pendingFileTarget, target => {
  const file = target?.pathFile
  if (!file || typeof file.directoryId !== 'string') return
  uiStore.pendingFileTarget = null
  const id = file.directoryId as DesktopFileDirectory
  nav.navigateTo(-1)
  nav.enterFolder({ id, name: options.value.find(option => option.value === id)?.label ?? file.directoryName, target: { directoryId: id, relativePath: '' } })
  const parts = file.relativePath.split('/').filter(Boolean)
  if (target.kind === 'file') parts.pop()
  for (const [index, name] of parts.entries()) {
    const relativePath = parts.slice(0, index + 1).join('/')
    nav.enterFolder({ id: relativePath, name, target: { directoryId: id, relativePath } })
  }
}, { immediate: true })

const showWorkspaceCreate = ref(false)
const canManageWorkspace = (entry: FolderCardMeta) => native && entry.id.startsWith('desktop:')
const renameWorkspace = (id: string, name: string) => rename(id as DesktopFileDirectory, name)
const unbindWorkspace = (id: string) => remove(id as DesktopFileDirectory)

async function addWorkspace() {
  if (!native) {
    showAppNotice(t('filesUi.addDesktopWorkspaceNative'))
    return
  }
  const id = await pick()
  if (typeof id !== 'string') return
  showWorkspaceCreate.value = false
  const name = options.value.find(option => option.value === id)?.label
  if (name) openLocation({ id, displayName: name, type: 'workspace', count: null })
}

watch(desktopWorkspaceRelinked, event => {
  if (event?.id !== directoryId.value || !target.value) return
  const root = breadcrumbs.value[0]
  nav.reset()
  if (root) nav.enterFolder(root)
  selection.clearSelection()
  selection.clearCut()
  refreshFiles()
})

function segmentName(segment: Segment) {
  if (segment.target?.directoryId === 'personal' && segment.target.relativePath === 'download') return t('filesUi.downloadsFolder')
  return options.value.find(option => option.value === segment.id)?.label ?? segment.name
}

function openDirectory(entry: PathFileEntry) {
  const location = target.value
  if (location) nav.enterFolder({ id: entry.relativePath, name: entry.name, target: { ...location, relativePath: entry.relativePath } })
}
function dropFiles(event: DragEvent) {
  if (event.dataTransfer?.types.includes('Files')) void files.value?.handleDrop(event)
}
async function createFolder() {
  const name = folderName.value.trim()
  const location = target.value
  if (!location || !name || creating.value) return
  if (/[\/\\]/.test(name)) { showAppError(t('projects.invalidName')); return }
  creating.value = true
  try {
    await pathFilesApi.createFolder({ ...location, relativePath: [location.relativePath, name].filter(Boolean).join('/') })
    folderName.value = ''
    showNewFolder.value = false
    reload.value++
  } catch (error) { showAppError(errorMessage(error)) }
  finally { creating.value = false }
}
</script>

<template>
  <FileBrowserPanel class="desktop-files" :show-new-folder-button="!!target" :show-selection="!!target" :show-sort="!!target" :can-paste="canPaste" :paste-count="pasteCount"
    :selection-mode="selectionMode" v-model:view-mode="viewMode" v-model:show-new-folder="showNewFolder"
    v-model:new-folder-name="folderName" :folder-loading="creating"
    :sort-options="sortOptions" :sort-key="sortKey" :sort-dir="sortDir"
    @paste="selection.paste" @toggle-selection="selection.toggleSelection" @create-folder="createFolder" @sort-select="onSortSelect">
    <template #breadcrumb>
      <FileBrowserHistory :can-go-back="canGoBack" :can-go-forward="canGoForward" @back="nav.goBack" @forward="nav.goForward" />
      <FileBrowserBreadcrumb>
        <button type="button" class="bc-item" :class="{ active: !current }" @click="current && nav.navigateTo(-1)">
          <span class="bc-label">{{ t('files.all') }}</span>
        </button>
        <template v-for="(segment, index) in breadcrumbs" :key="index">
          <Icon name="action.chevron-next" class="bc-arrow" :size="10" aria-hidden="true" />
          <RuntimeBreadcrumbTarget v-if="breadcrumbDestination(index) !== undefined"
            type="button" class="bc-item"
            :target-id="breadcrumbSurfaceId(surfaceId, index)" :surface-id="breadcrumbSurfaceId(surfaceId, index)"
            @click="nav.navigateTo(index)">
            <span class="bc-label">{{ segmentName(segment) }}</span>
          </RuntimeBreadcrumbTarget>
          <button v-else type="button" class="bc-item" :class="{ active: segment === current }" @click="segment !== current && nav.navigateTo(index)">
            <span class="bc-label">{{ segmentName(segment) }}</span>
          </button>
        </template>
      </FileBrowserBreadcrumb>
    </template>

    <template #toolbar-extra>
      <ActionButton v-if="!current" variant="primary" fit :disabled="busy" @click="showWorkspaceCreate = true">
        <Icon name="admin.stack" :size="13" />{{ t('filesUi.addDesktopWorkspace') }}
      </ActionButton>
    </template>
    <template #trailing>
      <DesktopRevealButton v-if="target" :directory-id="target.directoryId" :path="target.relativePath" />
    </template>
    <div ref="main" class="desktop-file-panel glass-card scroll-surface" @mousedown="selection.onContainerMouseDown"
      @dragover.prevent @drop.prevent="dropFiles">
      <div v-if="selectionRect" class="desktop-file-selection" :style="{
        left: selectionRect.left + 'px', top: selectionRect.top + 'px',
        width: selectionRect.width + 'px', height: selectionRect.height + 'px',
      }" />
      <PathFiles v-if="target" ref="files" :directory-id="target.directoryId" :relative-path="target.relativePath"
        :runtime-surface-id="surfaceId" :view-mode="viewMode" :sort-key="sortKey" :sort-dir="sortDir" :reload="reload"
        native-file-drag :cut-paths="cutPaths" :selected-paths="selectedPaths" :preview-paths="previewPaths" :selection-mode="selectionMode"
        @open-directory="openDirectory" @sort-select="onSortSelect" @select="selection.select"
        @cut="selection.cutSelected" @trash="selection.trashEntry" @renamed="selection.clearCut" />
      <template v-else>
        <SkeletonGate v-if="isProjects && projectsPending && !visibleLocations.length">
          <PageSkeleton :variant="viewMode" :collection="viewMode === 'grid' ? 'files' : undefined" />
        </SkeletonGate>
        <div v-else-if="isProjects && projectsError && !visibleLocations.length" class="grid-empty" role="alert">
          <p>{{ projectsError }}</p>
          <ActionButton fit variant="secondary" @click="loadProjects">{{ t('common.actions.retry') }}</ActionButton>
        </div>
        <div v-else-if="isProjects && !visibleLocations.length" class="grid-empty">{{ t('filesUi.desktopNoProjectFolders') }}</div>
        <FileLibraryLocations v-else :entries="visibleLocations" :view-mode="viewMode"
          :layout-collection="`${surfaceId}:locations`" :can-manage="canManageWorkspace" :busy="busy"
          :rename-workspace="renameWorkspace" @unbind="unbindWorkspace" @open="openLocation" />
      </template>
    </div>

    <FileSelectionToolbar v-if="fileCount + folderCount > 0" path-actions
      :file-count="fileCount" :folder-count="folderCount" @cut="selection.cutSelected()" @copy="selection.copySelected"
      @download="selection.downloadSelected" @delete="selection.trashSelected" @cancel="selection.clearSelection" />
    <WorkspaceCreateDialog local :show="showWorkspaceCreate" :busy="busy"
      @close="showWorkspaceCreate = false" @submit="addWorkspace" />
  </FileBrowserPanel>
</template>

<style scoped>
.desktop-files {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  gap: var(--space-md);
  position: relative;
}
.desktop-file-panel {
  flex: 1;
  min-height: 0;
  box-sizing: border-box;
  overflow: auto;
  padding: var(--space-lg);
  position: relative;
}
.desktop-file-selection { position: absolute; pointer-events: none; z-index: 4; border: 1px solid var(--action-outline); background: var(--action-soft); }
</style>
