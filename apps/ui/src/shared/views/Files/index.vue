<template>
  <FileBrowserPanel
    class="files-page"
    :can-paste="pathCanPaste"
    :paste-count="pathPasteCount"
    :selection-mode="currentType === 'trash' ? diskTrash.selectionMode.value : pathSelectionMode"
    :show-selection="currentType === 'trash' || !!workspaceTarget"
    :show-view-toggle="currentType !== 'trash'"
    :show-new-folder-button="canUpload || !!workspaceTarget"
    :show-sort="currentType !== 'root'"
    :view-mode="viewMode"
    :show-new-folder="showNewFolderInput"
    :new-folder-name="newFolderName"
    :folder-loading="newFolderLoading"
    :sort-options="currentType === 'trash' ? trashSortOptions : workspaceTarget ? workspaceSortOptions : SORT_OPTIONS"
    :sort-key="currentType === 'trash' ? trashSortKey : workspaceTarget ? workspaceSortKey : sortKey"
    :sort-dir="currentType === 'trash' ? trashSortDir : workspaceTarget ? workspaceSortDir : sortDir"
    @click="onPageClick"
    @paste="ctxPaste"
    @toggle-selection="currentType === 'trash' ? diskTrash.toggleSelection() : pathSelection.toggleSelection()"
    @update:view-mode="viewMode = $event"
    @update:show-new-folder="showNewFolderInput = $event"
    @update:new-folder-name="newFolderName = $event"
    @create-folder="createFolder"
    @sort-select="currentType === 'trash' ? selectTrashSort($event) : workspaceTarget ? selectWorkspaceSort($event) : onSortSelect($event)"
  >

    <template #breadcrumb>
      <FileBrowserHistory :can-go-back="canGoBack" :can-go-forward="canGoForward" @back="goBack" @forward="goForward" />
      <FileBrowserBreadcrumb>
        <button class="bc-item" :class="{ active: navPath.length === 0 }" @click="navigateTo(-1)">
          <span class="bc-label">{{ t('files.all') }}</span>
        </button>
        <template v-for="(seg, i) in navPath" :key="i">
          <svg class="bc-arrow" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <path d="M3 2l4 3-4 3"/>
          </svg>
          <RuntimeBreadcrumbTarget v-if="isBcDroppable(seg, i)" class="bc-item"
            :target-id="`bc:${i}`"
            :surface-id="breadcrumbSurfaceId(RUNTIME_SCOPE, i)"
            :class="{ active: i === navPath.length - 1 }"
            :data-bc-idx="i"
            @click="navigateTo(i)"
          >
            <span v-if="seg.color" class="bc-dot" :style="{ background: seg.color }"></span>
            <span class="bc-label">{{ navSegmentLabel(seg) }}</span>
          </RuntimeBreadcrumbTarget>
          <button v-else class="bc-item"
            :class="{ active: i === navPath.length - 1 }"
            @click="navigateTo(i)"
          >
            <span v-if="seg.color" class="bc-dot" :style="{ background: seg.color }"></span>
            <span class="bc-label">{{ navSegmentLabel(seg) }}</span>
          </button>
        </template>
      </FileBrowserBreadcrumb>
    </template>

    <template #toolbar-extra>
      <ActionButton v-if="currentType === 'root'" variant="primary" fit @click="workspaceDirectoryPanel?.openCreate()">
        <Icon name="admin.stack" :size="13" />{{ t('workspaceUi.createWorkspace') }}
      </ActionButton>
      <FileTrashToolbarActions v-if="currentType === 'trash'"
        :has-items="diskTrash.entries.value.length > 0"
        :all-selected="diskTrash.allSelected.value"
        :empty-busy="diskTrash.busy.value"
        :empty-progress="diskTrash.progress.value"
        @toggle-select="diskTrash.toggleAll"
        @empty="diskTrash.empty" />
    </template>

    <template #trailing>
      <FileStorageUsage :used="storageInfo.used" :loaded="storageInfo.loaded" />
    </template>

    <!-- 内容区 -->
    <div class="files-body">
      <div class="files-main glass-card scroll-surface" ref="mainRef"
        :class="{ 'is-selecting': pathSelection.boxStart.value !== null }"
        @dragover.prevent
        @drop.prevent="dropFiles"
        @mousedown="onMainMouseDown"
        style="position:relative"
      >

        <!-- 目录切换直接替换当前投影：不保留上一目录 DOM，不做交叉淡化或 Presence 离场。 -->
        <div class="content-body">

        <!-- ── 回收站视图 ── -->
        <PathFiles v-if="workspaceTarget"
          ref="workspaceFiles" :runtime-surface-id="runtimeBrowserSurfaceId"
          :directory-id="workspaceTarget.directoryId" :relative-path="workspaceTarget.relativePath"
          :view-mode="viewMode" :sort-key="workspaceSortKey" :sort-dir="workspaceSortDir" :reload="workspaceReload"
          :cut-paths="pathCutPaths" :selected-paths="pathSelectedPaths" :preview-paths="pathPreviewPaths"
          :selection-mode="pathSelectionMode"
          @sort-select="selectWorkspaceSort"
          @cut="pathSelection.cutSelected"
          @trash="pathSelection.trashEntry"
          @select="pathSelection.select"
          @renamed="pathSelection.clearCut"
          @compressed="pathSelection.clearSelection"
          @open-directory="openDiskDirectory" />
        <DiskTrashView v-else-if="currentType === 'trash'"
          :entries="sortedDiskTrash" :loading="diskTrash.loading.value" :error="diskTrash.error.value"
          :selection-mode="diskTrash.selectionMode.value" :selected="diskTrash.selected.value" :busy="diskTrash.busy.value"
          @load="diskTrash.load" @select="diskTrash.select" @restore="diskTrash.restore" @purge="diskTrash.purge" />
        <!-- ── 网格视图 ── -->
        <SkeletonGate v-else-if="loading && !contents.folders.length && !contents.files.length">
          <PageSkeleton :variant="viewMode" :collection="viewMode === 'grid' ? 'files' : undefined" />
        </SkeletonGate>
        <FilesGridView v-else-if="viewMode === 'grid'" :context="gridViewContext">
          <WorkspaceDirectoryPanel v-if="currentType === 'root'" ref="workspaceDirectoryPanel" mode="grid" @open="openWorkspaceDirectory" />
        </FilesGridView>
        <!-- ── 列表视图 ── -->
        <FilesListView v-else :context="listViewContext">
          <WorkspaceDirectoryPanel v-if="currentType === 'root'" ref="workspaceDirectoryPanel" mode="list" @open="openWorkspaceDirectory" />
        </FilesListView>

        </div>
      </div>
    </div>

    <!-- 批量操作浮动栏 -->
    <FileSelectionToolbar
      v-if="currentType === 'trash' ? selectedFileCount + selectedFolderCount > 0 : workspaceTarget && selectedFileCount + selectedFolderCount > 0"
      :file-count="selectedFileCount"
      :folder-count="selectedFolderCount"
      :path-actions="!!workspaceTarget"
      :path-compress="!!workspaceTarget && !!pathFileAccess.compressArchive"
      :path-download="!!workspaceTarget && !!pathFileAccess.downloadArchive"
      :downloading="pathSelection.downloading.value"
      :trash="currentType === 'trash'"
      @archive="workspaceFiles?.openSelectedCompression()"
      @download="pathSelection.downloadSelected()"
      @cut="pathSelection.cutSelected()"
      @copy="pathSelection.copySelected()"
      @delete="pathSelection.trashSelected()"
      @restore="diskTrash.restore()"
      @permanent-delete="diskTrash.purge()"
      @cancel="clearSelection"
    />
  </FileBrowserPanel>

</template>

<script setup lang="ts">
import { useFileViewMode } from '@/composables/files/useFileViewMode'
import SkeletonGate from '@/components/common/feedback/skeleton/SkeletonGate.vue'
import PageSkeleton from '@/components/common/feedback/skeleton/PageSkeleton.vue'

import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import FileStorageUsage from '@/components/common/file-browser/FileStorageUsage.vue'
import FileTrashToolbarActions from '@/components/common/file-browser/FileTrashToolbarActions.vue'
import DiskTrashView from '@/views/Files/components/DiskTrashView.vue'
import FilesGridView from '@/views/Files/components/FilesGridView.vue'
import FilesListView from '@/views/Files/components/FilesListView.vue'
import FileBrowserHistory from '@/components/common/file-browser/FileBrowserHistory.vue'
import FileBrowserBreadcrumb from '@/components/common/file-browser/FileBrowserBreadcrumb.vue'
import RuntimeBreadcrumbTarget from '@/components/common/file-browser/RuntimeBreadcrumbTarget.vue'
import FileBrowserPanel from '@/components/common/file-browser/FileBrowserPanel.vue'
import FileSelectionToolbar from '@/components/common/file-browser/FileSelectionToolbar.vue'
import { usePathFileAccess } from '@/services/pathFileAccess'
import { uploadSignal } from '@/services/cache'
import { useProjectStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'
import type { NavSeg, FolderCard } from '@/utils/filesNav'
import { useFilesNav } from '@/composables/files/useFilesNav'
import { useFileLibraryNavigation } from '@/composables/files/useFileLibraryNavigation'
import { useFileLibraryDirectory } from '@/composables/files/useFileLibraryDirectory'
import { watchDebouncedRevision } from '@/composables/shared/liveRevisionRefresh'
import { useFileLibrarySorting } from '@/composables/files/useFileLibrarySorting'
import { useDiskTrash } from '@/composables/files/useDiskTrash'
import { errorMessage, showAppError } from '@/composables/core/useAppToast'
import { useFileStorageUsage } from '@/composables/files/useFileStorageUsage'
import { useFileLibraryFolderPresentation } from '@/composables/files/useFileLibraryFolderPresentation'
import { useFileLibraryFolderActions } from '@/composables/files/useFileLibraryFolderActions'
import { type WorkspaceDirectory, type PathFileEntry, type PathFileRef } from '@/services/api'
import { useLiveStore } from '@/stores/live'
import { useSorting } from '@/composables/shared/useSorting'
import { projectStatusLabelKey } from '@/utils/projectStages'
import WorkspaceDirectoryPanel from '@/views/Files/components/WorkspaceDirectoryPanel.vue'
import { hasShortcutOverlay } from '@/interaction/keyboardShortcuts'
import { usePathFileSelection } from '@/composables/files/usePathFileSelection'
import PathFiles from '@/views/Files/components/PathFiles.vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import Icon from '@/components/common/icons/Icon.vue'
import { runtime } from '@/interaction/runtime'
import { useRuntimeAction } from '@/interaction/runtime/vue'
import { browserSurfaceId as makeBrowserSurfaceId, breadcrumbSurfaceId, parseBreadcrumbSurfaceId } from '@/interaction/runtime/adapters/file/fileRuntimeAdapter'

const projectStore = useProjectStore()
const uiStore      = useUiStore()

// ── 存储用量 ──
const { storageInfo, fetchStorage } = useFileStorageUsage()
const { t } = useI18n()

function navSegmentLabel(segment: NavSeg): string {
  if (segment.type === 'disk-personal' && segment.relativePath === 'download') return t('filesUi.downloadsFolder')
  if (segment.type === 'personal') return t('filesUi.personalFiles')
  if (segment.type === 'projects') return t('filesUi.projectFiles')
  if (segment.type === 'trash') return t('filesUi.trash')
  if (segment.type === 'status') return t(projectStatusLabelKey(segment.status ?? ''))
  if (segment.type === 'year') return t('filesUi.year', { year: segment.year })
  if (segment.type === 'month') return t('filesUi.month', { month: parseInt(String(segment.month)) })
  return segment.name
}

// ── 视图状态 ──
// 使用模块级 cardBlobReadyIds：首次 @load 后写入，session 内二次访问直接显示跳过动画
const viewMode = useFileViewMode('library')
const loading     = ref(false)
const mainRef     = ref<HTMLElement | null>(null)
const workspaceDirectoryPanel = ref<InstanceType<typeof WorkspaceDirectoryPanel> | null>(null)
const live        = useLiveStore()
let directoryLoader: () => void = () => {}
function loadContents() { directoryLoader() }

// 列表行是高频阅读型布局，抓取时保持平面，避免 Runtime 默认的 rotateX
// 把行内容变成“上窄下宽”。网格卡片仍保留原有的 3D 抓取手感；这里仅在
// 文件页存活期间切换 Runtime 的全局跟手姿态，离开页面时恢复默认值。
function syncFileDragRotation(mode: 'grid' | 'list') {
  runtime.configureMotion({
    controller: { rotation: { tilt: mode === 'list' ? 0 : 5 } },
  })
}
watch(viewMode, syncFileDragRotation, { immediate: true })
// 状态文件夹的色 / 图标（待开始灰 / 进行中蓝 / 已完成绿）
const { folderListIcon, folderAccentColor } = useFileLibraryFolderPresentation()

// ── Runtime Core API：浏览区 Surface ──
// Surface 继续服务真实拖拽；目录导航只更新当前目录状态，不再进入 Runtime 布局事务。
const RUNTIME_SCOPE = 'files'
const runtimeBrowserSurfaceId = makeBrowserSurfaceId(RUNTIME_SCOPE)
const browserSurfaceGeneration = runtime.surfaces.register({
  id: runtimeBrowserSurfaceId,
  type: 'file-browser',
  accepts: ['file-item', 'folder-item'],
  layout: 'grid',
  element: null,
  viewport: () => mainRef.value,
})
watch(mainRef, (element, previous) => {
  const current = runtime.surfaces.get(runtimeBrowserSurfaceId)
  if (current?.generation !== browserSurfaceGeneration) return
  if (element === null && current.element && current.element !== previous) return
  runtime.surfaces.setElement(runtimeBrowserSurfaceId, element)
}, { flush: 'post' })

/** 目录切换不创建 FLIP/Presence 离场代理；Runtime 对受控对象负责延迟注销。 */
function withDirectNav(mutate: () => void): void {
  mutate()
}

// ── 导航 ──
const {
  navPath, canGoBack, canGoForward,
  goBack: rawGoBack, goForward: rawGoForward,
  currentType, currentSeg, projectSeg, canUpload,
  saveNav, enterFolder: rawEnterFolder, navigateTo: rawNavigateTo, restoreNav,
} = useFilesNav({ loadContents, clearSelection })

function enterFolder(folder: FolderCard): void { withDirectNav(() => rawEnterFolder(folder)) }
function openWorkspaceDirectory(directory: WorkspaceDirectory): void {
  enterFolder({
    id: `workspace:${directory.id}`,
    type: 'disk-workspace',
    displayName: directory.name,
    count: directory.fileCount + directory.folderCount,
    fileCount: directory.fileCount,
    folderCount: directory.folderCount,
    space: 'workspace',
    workspaceDirectoryId: directory.id,
  })
}
function openDiskDirectory(entry: PathFileEntry) {
  const target = workspaceTarget.value
  if (!target) return
  const type = typeof target.directoryId === 'number' ? 'disk-workspace'
    : target.directoryId === 'personal' ? 'disk-personal' : 'disk-project'
  enterFolder({ id: entry.relativePath, type, displayName: entry.name,
    count: null, workspaceDirectoryId: typeof target.directoryId === 'number' ? target.directoryId : undefined, relativePath: entry.relativePath })
}
const workspaceReload = ref(0)
const workspaceFiles = ref<InstanceType<typeof PathFiles> | null>(null)
const pathFileAccess = usePathFileAccess()
const workspaceTarget = computed<PathFileRef | null>(() => {
  const segment = currentSeg.value
  if (!segment) return null
  if (segment.type === 'personal' || segment.type === 'disk-personal')
    return { directoryId: 'personal', relativePath: segment.relativePath ?? '' }
  if ((segment.type === 'project' || segment.type === 'disk-project') && projectSeg.value?.id != null)
    return { directoryId: `project:${projectSeg.value.id}`, relativePath: segment.relativePath ?? '' }
  if (segment.type === 'disk-workspace' && segment.workspaceDirectoryId != null)
    return { directoryId: segment.workspaceDirectoryId, relativePath: segment.relativePath ?? '' }
  return null
})
watch(workspaceTarget, target => { uiStore.workspaceUploadTarget = target }, { immediate: true, flush: 'sync' })
onUnmounted(() => { uiStore.workspaceUploadTarget = null })

const pathSelection = usePathFileSelection({
  target: workspaceTarget,
  container: mainRef,
  getEntries: () => workspaceFiles.value?.selectableEntries() ?? [],
  getSelectedEntries: () => workspaceFiles.value?.selectedEntries() ?? [],
  reload: () => { workspaceReload.value++ },
})
const {
  selectionMode: pathSelectionMode, fileCount: pathFileCount, folderCount: pathFolderCount,
  selectedPaths: pathSelectedPaths, previewPaths: pathPreviewPaths, cutPaths: pathCutPaths,
  pasteCount: pathPasteCount, canPaste: pathCanPaste,
} = pathSelection

function clearSelection() {
  pathSelection.clearSelection()
  if (currentType.value === 'trash') diskTrash.clearSelection()
}

function navigateTo(idx: number): void {
  if (workspaceTarget.value && idx === navPath.value.length - 1) {
    workspaceReload.value++
    return
  }
  withDirectNav(() => rawNavigateTo(idx))
}
function goBack(): void { withDirectNav(() => rawGoBack()) }
function goForward(): void { withDirectNav(() => rawGoForward()) }

const { jumpToTarget, consumePendingTarget } = useFileLibraryNavigation({
  projectStore,
  uiStore,
  navPath,
  saveNav,
  loadContents,
  clearSelection,
  mainRef,
})

// ── 排序 ──
const { SORT_OPTIONS, sortKey, sortDir, onSortSelect } = useSorting('files')
const { SORT_OPTIONS: workspaceAllSortOptions, sortKey: workspaceSortKey, sortDir: workspaceSortDir, onSortSelect: selectWorkspaceSort } = useSorting('workspace-files')
const workspaceSortOptions = computed(() => workspaceAllSortOptions.value.filter(({ key }) => key !== 'stage' && key !== 'createdAt'))

const directory = useFileLibraryDirectory({
  projectStore,
  currentType,
  currentSeg,
  loading,
  sortKey,
  sortDir,
})
const diskTrash = useDiskTrash(computed(() => currentType.value === 'trash'))
const { sortKey: trashSortKey, sortDir: trashSortDir, onSortSelect: selectTrashSort } = useSorting('disk-trash')
const trashSortOptions = computed(() => [
  { key: 'name', label: t('filesViewUi.name') },
  { key: 'createdAt', label: t('filesViewUi.deletedAt') },
])
const sortedDiskTrash = computed(() => [...diskTrash.entries.value].sort((a, b) => {
  const order = trashSortKey.value === 'createdAt' ? a.deletedAt.localeCompare(b.deletedAt) : a.name.localeCompare(b.name, undefined, { numeric: true })
  return order * (trashSortDir.value === 'asc' ? 1 : -1)
}))
directoryLoader = () => { if (!workspaceTarget.value && currentType.value !== 'trash') directory.loadContents() }
const { contents } = directory

const sortedContents = useFileLibrarySorting({ contents, currentType, sortKey, sortDir })

// tiny 已由 v-lazy-src 视口门控（更大 rootMargin 先于 card），不再全量预热——避免屏幕外缩略图挤占并发队列

onMounted(async () => {
  fetchStorage()
  // 顶栏搜索点了文件/文件夹：优先定位到目标目录，不走 restoreNav
  const target = consumePendingTarget()
  if (target?.workspaceDirectoryId == null && projectStore.projects.length === 0) {
    await projectStore.fetchProjects?.()
  }
  if (target) { jumpToTarget(target) } else { restoreNav(); loadContents() }
})

// 已在文件库页时再点搜索结果 → 监听信号直接定位
watch(() => uiStore.pendingFileTarget, (target) => {
  if (target) jumpToTarget(consumePendingTarget())
})

watch(uploadSignal, () => {
  // 上传链路会更新当前文件；仅重载可见目录，不为一次上传重新拉全库。
  loadContents()
  if (workspaceTarget.value) workspaceReload.value++
  fetchStorage()
})

// 目录是服务端按需快照，不依赖 filesCache 的全量刷新事件；外部文件变化时只刷新当前视图。
const stopWatchingFileRevision = watchDebouncedRevision(
  () => live.rev.files,
  () => {
    if (workspaceTarget.value) workspaceReload.value++
    else if (currentType.value === 'trash') void diskTrash.load()
    else loadContents()
  },
  120,
)

// ── 统一选择、多选与框选 ──
const selectedFileCount = computed(() => currentType.value === 'trash' ? diskTrash.fileCount.value
  : workspaceTarget.value ? pathFileCount.value : 0)
const selectedFolderCount = computed(() => currentType.value === 'trash' ? diskTrash.folderCount.value
  : workspaceTarget.value ? pathFolderCount.value : 0)
let suppressNextSelectionPageClick = false

function onMainMouseDown(e: MouseEvent) {
  if (workspaceTarget.value) pathSelection.onContainerMouseDown(e)
}

function onPageClick() {
  if (suppressNextSelectionPageClick) {
    suppressNextSelectionPageClick = false
    return
  }
  clearSelection()
  // 排序菜单由 SortMenu 内部的 ContextMenu 监听外部 click 自动关闭，这里不用手动处理
}

async function dropFiles(event: DragEvent) {
  try {
    await workspaceFiles.value?.handleDrop(event)
  } catch (error) {
    showAppError(errorMessage(error))
  }
}

// ── 拖动移动 ──
function isBcDroppable(seg: NavSeg, idx: number) {
  if (idx === navPath.value.length - 1) return false
  if (workspaceTarget.value) return diskBreadcrumbPath(seg) !== undefined
  return false
}

function diskBreadcrumbPath(seg: NavSeg | undefined) {
  const target = workspaceTarget.value
  if (!target || !seg) return
  const scope = target.directoryId
  const sameScope = typeof scope === 'number'
    ? seg.type === 'disk-workspace' && seg.workspaceDirectoryId === scope
    : scope === 'personal'
      ? seg.type === 'personal' || seg.type === 'disk-personal'
      : seg.type === 'disk-project' || (seg.type === 'project' && scope === `project:${seg.id}`)
  if (sameScope) return seg.relativePath ?? ''
}

// ── Runtime Core API 接入 ──
// 单文件/单文件夹和多选拖拽都交给 Interaction Runtime；这里仅负责注册
// Object/Surface/Target，并把 Action 转发给现有的业务移动函数。
// RUNTIME_SCOPE / runtimeBrowserSurfaceId 在文件靠前处声明，供导航守卫与拖拽注册共用。

function folderLayoutKey(folder: FolderCard): string { return `${RUNTIME_SCOPE}:directory:${folder.id}` }

useRuntimeAction(action => {
  if (action.type !== 'move' && action.type !== 'move-group') return
  suppressNextSelectionPageClick = true
  // 只吞掉拖拽结束时浏览器合成的那一次 click；不能让标记跨到用户下一次
  // 点击目标文件夹，否则目标会被选择模式拦截而无法导航。
  window.setTimeout(() => { suppressNextSelectionPageClick = false }, 0)
  const objectIds = action.type === 'move-group' ? action.objectIds : [action.objectId]
  if (workspaceFiles.value) {
    const index = parseBreadcrumbSurfaceId(RUNTIME_SCOPE, action.toSurfaceId)
    const destination = index === null ? undefined : diskBreadcrumbPath(navPath.value[index])
    return workspaceFiles.value.handleMoveAction(objectIds, action.toSurfaceId, pathSelection.moveInto, destination)
  }
})

onUnmounted(() => {
  stopWatchingFileRevision()
  if (runtime.surfaces.get(runtimeBrowserSurfaceId)?.generation === browserSurfaceGeneration) {
    runtime.surfaces.unregister(runtimeBrowserSurfaceId, browserSurfaceGeneration)
  }
  // 不把列表视图的平面姿态泄漏给其它页面的 Runtime 卡片。
  syncFileDragRotation('grid')
})

const folderActions = useFileLibraryFolderActions({
  pathTarget: workspaceTarget,
  reloadWorkspace: () => { workspaceReload.value++ },
})
const {
  newFolderName, newFolderLoading, showNewFolderInput,
  createFolder,
} = folderActions

const folderInputRef = ref<HTMLInputElement | null>(null)
watch(showNewFolderInput, (v) => { if (v) nextTick(() => folderInputRef.value?.focus()) })

const gridViewContext = {
  directoryViewportKey: computed(() => `${JSON.stringify(navPath.value)}:${sortKey.value}:${sortDir.value}`),
  contents, sortedContents, folderListIcon, folderAccentColor,
  folderLayoutKey, openFolder: enterFolder, loading,
  layoutCollection: 'files-browser',
}
const listViewContext = {
  directoryViewportKey: gridViewContext.directoryViewportKey,
  contents, sortedContents, sortKey, sortDir, onSortSelect, folderListIcon,
  folderAccentColor, folderLayoutKey, openFolder: enterFolder, loading, viewMode,
  layoutCollection: 'files-browser',
}

function ctxPaste() {
  if (workspaceTarget.value) return pathSelection.paste()
}

// ── 键盘快捷键 ──
function onKeyDown(event: KeyboardEvent) {
  if (hasShortcutOverlay(event.target)) return
  if (workspaceTarget.value) pathSelection.handleShortcut(event)
}

onMounted(() => document.addEventListener('keydown', onKeyDown))
onUnmounted(() => document.removeEventListener('keydown', onKeyDown))
</script>

<style scoped>
.files-page {
  display: flex; flex-direction: column; gap: var(--space-md);
  height: 100%; position: relative;
  user-select: none;
}

/* ── 工具栏 ── */
.files-toolbar {
  display: flex; align-items: center; justify-content: space-between;
  height: 52px; box-sizing: border-box;
  padding: 0 16px; flex-shrink: 0; gap: 12px;
  position: relative; z-index: 20;
}
.toolbar-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

.bc-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }

/* ── 内容区 ── */
.files-body {
  flex: 1; min-height: 0; position: relative; overflow: hidden;
}

.files-main {
  --scrollbar-overlay-right-offset: -8px;
  height: 100%; padding: 16px; overflow-y: auto; overflow-x: hidden;
  box-sizing: border-box;
}

/* ── 框选拖拽中：禁用子元素 hover 动效。FileCard/FolderCard 的实体 paint 在各自组件。 ── */
.files-main.is-selecting .fc-card,
.files-main.is-selecting :deep(.folder-card) {
  pointer-events: none;
  transform: none !important;
  transition: none !important;
}

/* FilesGridView / FileCard 已各自拥有网格和卡片视觉；
   页面入口不再复制这些 selector，避免模块化后形成父 scoped root 与子组件双 owner。 */

.content-body { width: 100%; height: 100%; display: contents; }
</style>
