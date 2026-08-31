<template>
  <FileBrowserPanel
    class="files-page"
    :can-paste="cbStore.hasContent() && currentType !== 'root' && currentType !== 'trash'"
    :paste-count="cbStore.fileIds.length + cbStore.folderIds.length"
    :selection-mode="inSelectionMode"
    :show-selection="currentType !== 'root'"
    :show-view-toggle="currentType !== 'trash'"
    :show-new-folder-button="currentType === 'personal' || currentType === 'project' || currentType === 'folder'"
    :show-new-workspace-button="preferencesStore.shellEnabled && currentType === 'folder' && currentSeg?.folderId != null && workspaceFoldersLoaded"
    :workspace-exists="Boolean(currentWorkspace)"
    :show-sort="currentType !== 'root'"
    :view-mode="viewMode"
    :show-new-folder="showNewFolderInput"
    :new-folder-name="newFolderName"
    :folder-loading="newFolderLoading"
    :sort-options="SORT_OPTIONS"
    :sort-key="sortKey"
    :sort-dir="sortDir"
    @click="onPageClick"
    @paste="ctxPaste"
    @toggle-selection="toggleSelectMode"
    @update:view-mode="viewMode = $event"
    @update:show-new-folder="showNewFolderInput = $event"
    @update:new-folder-name="newFolderName = $event"
    @create-folder="createFolder"
    @create-workspace="createWorkspace"
    @sort-select="onSortSelect"
  >

    <template #breadcrumb>
      <div class="breadcrumb-nav">
        <button class="nav-hist-btn" :disabled="!canGoBack" @click="goBack" :title="t('files.back')">
          <Icon name="action.back" :size="14" />
        </button>
        <button class="nav-hist-btn" :disabled="!canGoForward" @click="goForward" :title="t('files.forward')">
          <Icon name="action.next" :size="14" />
        </button>
      </div>
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
      <FileTrashToolbarActions v-if="currentType === 'trash'"
        :has-items="Boolean(contents.files.length || trashFolders.length)"
        :all-selected="allTrashSelected"
        @toggle-select="toggleSelectAllTrash"
        @empty="confirmEmptyTrash" />
    </template>

    <template #trailing>
      <FileStorageUsage :used="storageInfo.used" :limit="storageInfo.limit" :loaded="storageInfo.loaded" />
    </template>

    <!-- 内容区 -->
    <div class="files-body">
      <div class="files-main glass-card scroll-surface" ref="mainRef"
        :class="{ 'is-selecting': boxStart !== null }"
        @contextmenu.prevent.self="openCtx('empty', null, $event)"
        @dragenter.prevent="onDragEnter"
        @dragover.prevent
        @dragleave="onDragLeave"
        @drop.prevent="handleDrop"
        @mousedown="onMainMouseDown"
        style="position:relative"
      >
        <FileUploadDropOverlay :visible="isDragging" @drop="handleDrop" />

        <!-- 框选矩形 -->
        <div v-if="selectionRect" class="selection-rect" :style="{
          left: selectionRect.left + 'px',
          top:  selectionRect.top  + 'px',
          width: selectionRect.width + 'px',
          height: selectionRect.height + 'px',
        }"></div>

        <!-- 目录切换直接替换当前投影：不保留上一目录 DOM，不做交叉淡化或 Presence 离场。 -->
        <div class="content-body">

        <!-- ── 回收站视图 ── -->
        <FilesTrashView v-if="currentType === 'trash'" :context="trashViewContext" />
        <!-- ── 网格视图 ── -->
        <FilesGridView v-else-if="viewMode === 'grid'" :context="gridViewContext" />
        <!-- ── 列表视图 ── -->
        <FilesListView v-else :context="listViewContext" />

        </div>
      </div>
    </div>

    <!-- 批量操作浮动栏 -->
    <FileSelectionToolbar
      v-if="selectedIds.size > 0 || selectedFolderKeys.size > 0 || selectedTrashFolderIds.size > 0"
      :file-count="selectedIds.size"
      :folder-count="selectedFolderKeys.size + selectedTrashFolderIds.size"
      :downloading="downloadingZip"
      :trash="currentType === 'trash'"
      @download="downloadSelected"
      @cut="selCut"
      @copy="selCopy"
      @delete="deleteSelected"
      @restore="restoreSelected"
      @permanent-delete="hardDeleteSelected"
      @cancel="clearSelection"
    />
  </FileBrowserPanel>

  <!-- 右键菜单 -->
  <FileBrowserContextMenu :show="ctx.visible" :x="ctx.x" :y="ctx.y" @close="ctx.visible = false">
    <FileBrowserContextMenuContent
      :type="ctx.type"
      :mod-key="modKey"
      :folder-target-valid="ctx.target?.type === 'folder'"
      :can-paste="cbStore.hasContent()"
      @action="handleCtxMenuAction"
    />
  </FileBrowserContextMenu>

  <!-- 文件详细信息弹窗 -->
  <FileInfoPopup
    :show="infoPopup.show"
    :file="infoPopup.file"
    :x="infoPopup.x"
    :y="infoPopup.y"
    @close="infoPopup.show = false"
  />

  <!-- 上传同名冲突确认 -->
  <UploadConflictDialog ref="conflictDialogRef" />

</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import type { TrashFolderMeta } from '@/services/api'
import FileUploadDropOverlay from '@/components/common/file-browser/FileUploadDropOverlay.vue'
import FileStorageUsage from '@/components/common/file-browser/FileStorageUsage.vue'
import FileTrashToolbarActions from '@/components/common/file-browser/FileTrashToolbarActions.vue'
import FilesTrashView from '@/views/Files/components/FilesTrashView.vue'
import FilesGridView from '@/views/Files/components/FilesGridView.vue'
import FilesListView from '@/views/Files/components/FilesListView.vue'
import FileBrowserBreadcrumb from '@/components/common/file-browser/FileBrowserBreadcrumb.vue'
import RuntimeBreadcrumbTarget from '@/components/common/file-browser/RuntimeBreadcrumbTarget.vue'
import FileBrowserPanel from '@/components/common/file-browser/FileBrowserPanel.vue'
import FileBrowserContextMenu from '@/components/common/file-browser/FileBrowserContextMenu.vue'
import FileBrowserContextMenuContent from '@/components/common/file-browser/FileBrowserContextMenuContent.vue'
import FileInfoPopup from '@/components/common/FileInfoPopup.vue'
import FileSelectionToolbar from '@/components/common/FileSelectionToolbar.vue'
import { useClipboardStore } from '@/stores/clipboard'
import { uploadSignal } from '@/services/cache'
import { useProjectStore } from '@/stores/projects'
import { usePreferencesStore } from '@/stores/preferences'
import { usePreviewStore, isPreviewable, isAudioExt } from '@/stores/preview'
import { useFilesCacheStore } from '@/stores/filesCache'
import { useUiStore } from '@/stores/ui'
import { cardBlobReadyIds } from '@/composables/useThumbCache'
import { isImageExt, fileIconColor, fileListIcon } from '@/utils/fileTypes'
import { optimisticMutation } from '@/utils/optimisticMutation'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import { type NavSeg, type FolderCard as FolderCardMeta } from '@/utils/filesNav'
import { useFilesNav } from '@/composables/useFilesNav'
import { useFileLibraryNavigation } from '@/composables/files/useFileLibraryNavigation'
import { useFileLibraryDirectory } from '@/composables/files/useFileLibraryDirectory'
import { useFileLibrarySorting } from '@/composables/files/useFileLibrarySorting'
import { useFileLibrarySelection } from '@/composables/files/useFileLibrarySelection'
import { useFileLibraryBatchActions } from '@/composables/files/useFileLibraryBatchActions'
import { useFileLibraryTrashActions } from '@/composables/files/useFileLibraryTrashActions'
import { useFileActions } from '@/composables/files/useFileActions'
import { useFileLibraryContextActions } from '@/composables/files/useFileLibraryContextActions'
import { useFileLibraryUpload } from '@/composables/files/useFileLibraryUpload'
import { useFileLibraryRename } from '@/composables/files/useFileLibraryRename'
import { useFileStorageUsage } from '@/composables/files/useFileStorageUsage'
import { useFileLibraryFolderPresentation } from '@/composables/files/useFileLibraryFolderPresentation'
import { useFileLibraryFolderActions } from '@/composables/files/useFileLibraryFolderActions'
import { useFileLibraryFileActions } from '@/composables/files/useFileLibraryFileActions'
import { confirmDialog } from '@/composables/useConfirmDialog'
import { confirmFileDeletion } from '@/composables/files/useFileDeleteConfirm'
import { workspacesApi } from '@/services/api'
import { useFileRuntimeMove } from '@/composables/files/useFileRuntimeMove'
import { useSorting } from '@/composables/useSorting'
import { projectStatusLabelKey } from '@/utils/projectStages'
import UploadConflictDialog from '@/components/common/UploadConflictDialog.vue'
import Icon from '@/components/common/Icon.vue'
import { runtime } from '@/interaction/runtime'
import { useRuntimeAction } from '@/interaction/runtime/vue'
import {
  fileObjectId,
  browserSurfaceId as makeBrowserSurfaceId,
  breadcrumbSurfaceId,
} from '@/interaction/runtime/adapters/file/fileRuntimeAdapter'

const projectStore = useProjectStore()
const preferencesStore = usePreferencesStore()
const cacheStore   = useFilesCacheStore()
const uiStore      = useUiStore()
const cbStore      = useClipboardStore()
const fileActions = useFileActions()

// ── 存储用量 ──
const { storageInfo, fetchStorage } = useFileStorageUsage()
const { t } = useI18n()

function navSegmentLabel(segment: NavSeg): string {
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
const viewMode    = ref<'grid' | 'list'>('grid')
const loading     = ref(false)
const mainRef     = ref<HTMLElement | null>(null)
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

type WorkspaceFolder = { id: number; folderId?: number | null }
const workspaceFolders = ref<WorkspaceFolder[]>([])
const workspaceFoldersLoaded = ref(false)
const currentWorkspace = computed(() => {
  const folderId = currentSeg.value?.folderId
  if (folderId == null) return null
  return workspaceFolders.value.find(item => item.folderId === folderId) ?? null
})

async function refreshWorkspaceFolders() {
  workspaceFoldersLoaded.value = false
  try {
    const status = await workspacesApi.status()
    workspaceFolders.value = (status.items as WorkspaceFolder[]).filter(item => item.folderId != null)
  } catch {
    workspaceFolders.value = []
  } finally {
    workspaceFoldersLoaded.value = true
  }
}

async function createWorkspace() {
  const folder = currentSeg.value
  if (!folder || folder.type !== 'folder' || folder.folderId == null) return
  try {
    const existing = currentWorkspace.value
    if (existing) {
      if (!await confirmDialog({
        title: t('files.deleteWorkspaceTitle'),
        message: t('files.deleteWorkspaceMessage', { name: folder.name }),
        tone: 'danger',
        confirmText: t('files.deleteWorkspace'),
      })) return
      await workspacesApi.delete(existing.id)
      workspaceFolders.value = workspaceFolders.value.filter(item => item.id !== existing.id)
      uiStore.pushNotification({ title: t('files.workspace'), content: t('files.workspaceDeleted', { name: folder.name }), bubble: true, persist: false })
      return
    }
    await workspacesApi.create({ name: folder.name, kind: 'folder', folderId: folder.folderId })
    await refreshWorkspaceFolders()
    uiStore.pushNotification({ title: t('files.workspace'), content: t('files.workspaceCreated', { name: folder.name }), bubble: true, persist: false })
  } catch {
    uiStore.pushNotification({ title: t('files.workspace'), content: t('files.workspaceCreateFailed'), bubble: true, persist: false })
  }
}

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
  saveNav, enterFolder: rawEnterFolder, navigateTo: rawNavigateTo, restoreNav, pruneHistoryForFolders,
} = useFilesNav({ loadContents, clearSelection })

function enterFolder(folder: FolderCardMeta): void { withDirectNav(() => rawEnterFolder(folder)) }
function navigateTo(idx: number): void { withDirectNav(() => rawNavigateTo(idx)) }
function goBack(): void { withDirectNav(() => rawGoBack()) }
function goForward(): void { withDirectNav(() => rawGoForward()) }

const { jumpToTarget, consumePendingTarget } = useFileLibraryNavigation({
  projectStore,
  cacheStore,
  uiStore,
  navPath,
  saveNav,
  loadContents,
  clearSelection,
  mainRef,
})

// ── 排序 ──
const { SORT_OPTIONS, sortKey, sortDir, onSortSelect } = useSorting()

const directory = useFileLibraryDirectory({
  projectStore,
  cacheStore,
  currentType,
  currentSeg,
  loading,
  sortKey,
  sortDir,
})
directoryLoader = directory.loadContents
const {
  contents,
  trashFolders,
  expandedTrashFolders,
  trashFolderContents,
  sortedTrashFolders,
} = directory

const sortedContents = useFileLibrarySorting({ contents, currentType, sortKey, sortDir })

// tiny 已由 v-lazy-src 视口门控（更大 rootMargin 先于 card），不再全量预热——避免屏幕外缩略图挤占并发队列

onMounted(async () => {
  fetchStorage()
  refreshWorkspaceFolders()
  // 顶栏搜索点了文件/文件夹：优先定位到目标目录，不走 restoreNav
  const target = consumePendingTarget()
  // 热缓存：同步初始化，避免 await 微任务暂停导致空帧
  if (cacheStore.loaded && projectStore.projects.length > 0) {
    if (target) { jumpToTarget(target) } else { restoreNav(); loadContents() }
    return
  }
  await Promise.all([
    projectStore.projects.length === 0 ? projectStore.fetchProjects?.() : Promise.resolve(),
    cacheStore.loaded ? Promise.resolve() : cacheStore.load(),
  ])
  if (target) { jumpToTarget(target) } else { restoreNav(); loadContents() }
})

// 已在文件库页时再点搜索结果 → 监听信号直接定位
watch(() => uiStore.pendingFileTarget, (target) => {
  if (target) jumpToTarget(consumePendingTarget())
})

watch(uploadSignal, () => {
  // 上传信号由 uploadFiles 直接写入缓存；这里做一次静默后台刷新以纠偏
  cacheStore.refresh().then(() => loadContents())
  fetchStorage()
})

// 文件库数据变了（本页乐观更新 / 咕咕·IM·其它标签页经 filesCache 刷新或 remove 快路径）→ 重新投影当前视图。
// contents 是 loadContents 从 store getter 手动投影的本地快照，不是 computed，故 store 数据一变就得重投。
// 刷新/patch 的决策与「回声抑制」全在 filesCache 里统一做（见 filesCache.ts canonical event 消费）；本页不再自己
// 订阅 rev.files 重拉，避免与 filesCache 重复全量拉、并让回声抑制对本页同样生效（本页发起的改动不会再多刷一次）。
watch([() => cacheStore.allFiles, () => cacheStore.allFolders], () => {
  loadContents()
  fetchStorage()
})

// ── 统一选择、多选与框选 ──
const selection = useFileLibrarySelection({
  containerRef: mainRef,
  currentType,
  getFolders: () => sortedContents.value.folders,
  getFiles: () => sortedContents.value.files,
  getTrashFolders: () => trashFolders.value,
  enterFolder,
  openPreview: file => openPreview(file),
  isPreviewable,
})
const {
  selectedIds, selectedFolderKeys, selectedTrashFolderIds,
  previewFileIds, previewFolderKeys, boxStart, selectionRect,
  onContainerMouseDown: _boxMouseDown,
  clearSelection: clearSelectionImpl, inSelectionMode,
  toggleSelectMode, toggleSelectAllTrash, allTrashSelected,
  handleFolderClick, handleFileClick, handleTrashFileClick, handleTrashFolderClick,
} = selection
let suppressNextSelectionPageClick = false

function clearSelection() { clearSelectionImpl() }

function onMainMouseDown(e: MouseEvent) {
  if (currentType.value === 'root' || currentType.value === 'projects') return
  _boxMouseDown(e)
}

function onPageClick() {
  if (suppressNextSelectionPageClick) {
    suppressNextSelectionPageClick = false
    return
  }
  clearSelection()
  // 排序菜单由 SortMenu 内部的 ContextMenu 监听外部 click 自动关闭，这里不用手动处理
}

// ── 回收站工具函数 ──
function daysLeft(deletedAt: string | null | undefined) {
  if (!deletedAt) return 30
  const gone = Math.floor((Date.now() - new Date(deletedAt).getTime()) / 86400000)
  return Math.max(0, 30 - gone)
}

function formatDate(iso: string | null | undefined) {
  return iso ? iso.slice(0, 10) : '—'
}

const conflictDialogRef = ref<InstanceType<typeof UploadConflictDialog> | null>(null)
const fileUpload = useFileLibraryUpload({
  currentType,
  currentSeg,
  canUpload,
  fileCacheStore: cacheStore,
  loadContents,
  fetchStorage,
  showConflicts: conflicts => conflictDialogRef.value?.show(conflicts) ?? Promise.resolve(new Map()),
})
const { uploadingItems, handleFileInput, onDragEnter, onDragLeave, handleDrop, isDragging } = fileUpload

// ── 预览 ──
const previewStore = usePreviewStore()
const openPreview = (f: FileMeta) => {
  previewStore.open(f, sortedContents.value.files)
}

const batchActions = useFileLibraryBatchActions({
  fileActions,
  cacheStore,
  clipboardStore: cbStore,
  selectedFileIds: selectedIds,
  selectedFolderKeys,
  getFiles: () => sortedContents.value.files,
  getFolders: () => contents.value.folders,
  getCurrentFolderName: () => currentSeg.value?.name ?? null,
  clearSelection,
  loadContents,
  pruneHistoryForFolders: pruneHistoryForFolders,
  fetchStorage,
  getDestination: () => {
    const seg = currentSeg.value
    return {
      folderId: seg?.type === 'folder' ? (seg.folderId ?? null) : null,
      projectId: seg?.type === 'project' ? (seg.id ?? null) : (seg?.projectId ?? null),
    }
  },
  showConflicts: conflicts => conflictDialogRef.value?.show(conflicts) ?? Promise.resolve(new Map()),
})
const downloadingZip = batchActions.downloading
const trashActions = useFileLibraryTrashActions({
  selectedFileIds: selectedIds,
  selectedTrashFolderIds,
  expandedTrashFolders,
  trashFolderContents,
  loadContents,
  clearSelection,
  refreshCache: () => cacheStore.refresh(),
  fetchStorage,
})

const restoreFile = (file: FileMeta) => trashActions.restoreFile(file)
const restoreTrashFolder = (folder: TrashFolderMeta) => trashActions.restoreFolder(folder)
const toggleTrashFolder = (folder: TrashFolderMeta) => trashActions.toggleFolder(folder)
const hardDeleteFile = (file: FileMeta) => trashActions.hardDeleteFile(file)
const hardDeleteTrashFolder = (folder: TrashFolderMeta) => trashActions.hardDeleteFolder(folder)
const restoreSelected = () => trashActions.restoreSelected()
const hardDeleteSelected = () => trashActions.hardDeleteSelected()
const confirmEmptyTrash = () => trashActions.emptyTrash()

// 页面级回收站视图的依赖集中从入口注入，视图组件不直接读取 stores 或执行 API。
const trashViewContext = {
  trashFolders, contents, sortedContents, sortedTrashFolders, expandedTrashFolders, trashFolderContents,
  sortKey, sortDir, onSortSelect, inSelectionMode, selectedTrashFolderIds, selectedIds,
  previewFolderKeys, previewFileIds, handleTrashFolderClick, toggleTrashFolder,
  restoreTrashFolder, hardDeleteTrashFolder, handleTrashFileClick, restoreFile,
  hardDeleteFile, fileListIcon, fileIconColor, formatDate, daysLeft, loading,
}

function downloadSelected() {
  return batchActions.downloadSelected()
}

function deleteSelected() {
  return batchActions.deleteSelected()
}

const filePageActions = useFileLibraryFileActions({ cacheStore, fileActions, selectedIds, loadContents, fetchStorage })
const { downloadFile, deleteSingleFile } = filePageActions

// ── 重命名 ──
const rename = useFileLibraryRename({
  getFile: id => cacheStore.getFile(id),
  getFolder: id => cacheStore.getFolder(id),
  updateFile: (id, patch) => cacheStore.updateFile(id, patch),
  updateFolder: (id, patch) => cacheStore.updateFolder(id, patch),
  renameFile: async (id, name) => { await fileActions.renameFile(id, name) },
  renameFolder: async (id, name, version) => {
    const updated = await fileActions.renameFolder(id, name, version)
    return { version: updated.version }
  },
  reload: loadContents,
  onError: (scope, error) => console.error(`[Files] ${scope === 'file' ? '文件' : '文件夹'}重命名失败:`, (error as Error).message),
})
const {
  renamingFileId, renamingFolderKey, renameText,
  startFile: startRenameFile, startFolder: startRenameFolder,
  cancel: cancelRename, commit: commitRename,
} = rename

// ── 拖动移动 ──
// pointer 模式（setPointerCapture 自建拖拽，不是原生 HTML5 draggable/dragstart——原生拖拽从
// dragstart 起浏览器会整段暂停 mouseover/mouseout 派发，导致落地揭示卡片时 hover 高亮跳变，
// perf trace 实测证实）。单选/多选均由 Interaction Runtime 接管；拖拽中由 Runtime 命中
// 目标并派发 Action，这里只提供 Files 特有的目标解析和业务移动 API。
function isBcDroppable(seg: NavSeg, idx: number) {
  // folder/personal/project 段都可作为拖放目标：folder→该文件夹，personal/project→对应根（parentId=null，
  // resolveBcTarget 里非 folder 段一律映射为 null）。此前漏了 project，导致子目录文件夹拖不回项目根。
  // idx 是当前目录本身这一段（navPath 最后一位）时排除——拖回来不算有效落点，应该直接归位，
  // 不该演一遍飞入动画。
  if (idx === navPath.value.length - 1) return false
  return seg.type === 'folder' || seg.type === 'personal' || seg.type === 'project'
}

async function moveFoldersInto(folderIds: Array<number | string>, targetFolderId: number | string | null) {
  const nFolderIds = folderIds as number[]
  const nTarget = targetFolderId as number | null
  const targetProjectId = currentSeg.value?.type === 'project'
    ? currentSeg.value.id
    : (currentSeg.value?.projectId ?? null)
  const backups = nFolderIds.map(id => cacheStore.getFolder(id)).filter(Boolean) as FolderMeta[]
  let results: FolderMeta[] = []
  await optimisticMutation({
    apply: () => nFolderIds.forEach(id => cacheStore.updateFolder(id, { parentId: nTarget })),
    afterMutate: loadContents,
    // version 在 apply() 之后、work() 之前读——apply 只改 parentId，此时缓存里的 version 仍是
    // 服务端当前值；对不上（并发改动）后端给 409，走 rollback + loadContents 拉回真实状态。
    work: async () => {
      results = await Promise.all(nFolderIds.map(id =>
        fileActions.moveFolder(id, nTarget, cacheStore.getFolder(id)?.version ?? 1, targetProjectId)))
    },
    rollback: () => backups.forEach(b => cacheStore.updateFolder(b.id, { parentId: b.parentId })),
    onCommit: () => results.forEach(r => cacheStore.updateFolder(r.id, { version: r.version })),
    onError: err => console.error('[Files] 移动文件夹失败:', (err as Error).message),
  })
}
async function moveFilesInto(fileIds: Array<number | string>, targetFolderId: number | string | null) {
  const nFileIds = fileIds as number[]
  const nTarget = targetFolderId as number | null
  const backups = nFileIds.map(id => cacheStore.getFile(id)).filter(Boolean) as FileMeta[]
  await optimisticMutation({
    apply: () => nFileIds.forEach(id => cacheStore.updateFile(id, { folderId: nTarget })),
    afterMutate: loadContents,
    work: () => Promise.all(nFileIds.map(id => fileActions.moveFile(id, nTarget))),
    rollback: () => backups.forEach(f => cacheStore.updateFile(f.id, { folderId: f.folderId })),
    onError: err => console.error('[Files] 移动失败:', (err as Error).message),
  })
}

// ── Runtime Core API 接入 ──
// 单文件/单文件夹和多选拖拽都交给 Interaction Runtime；这里仅负责注册
// Object/Surface/Target，并把 Action 转发给现有的业务移动函数。
// RUNTIME_SCOPE / runtimeBrowserSurfaceId 在文件靠前处声明，供导航守卫与拖拽注册共用。

function folderLayoutKey(f: FolderCardMeta): string {
  // 真实文件夹卡复用全局唯一的 fileObjectId；伪文件夹卡没有 Runtime Object id，仍保留
  // 稳定 layout key，供同目录内的 Runtime 布局/拖拽事务识别，不再用于目录切换 Presence。
  return f.type === 'folder' && f.folderId != null
    ? fileObjectId(RUNTIME_SCOPE, 'folder', f.folderId)
    : `${RUNTIME_SCOPE}:pseudo-folder:${f.id}`
}
function fileLayoutKey(f: FileMeta): string {
  return fileObjectId(RUNTIME_SCOPE, 'file', f.id)
}

const { handleAction: handleRuntimeMoveAction } = useFileRuntimeMove({
  scope: RUNTIME_SCOPE,
  browserSurfaceId: runtimeBrowserSurfaceId,
  resolveBreadcrumbTarget: idx => {
    const seg = navPath.value[idx]
    if (!seg || !isBcDroppable(seg, idx)) return null
    return { folderId: seg.type === 'folder' ? (seg.folderId ?? null) : null, droppedOn: 'breadcrumb' }
  },
  moveFolders: moveFoldersInto,
  moveFiles: (ids, targetFolderId) => moveFilesInto(ids, targetFolderId),
  clearSelection,
})

useRuntimeAction(action => {
  if (action.type !== 'move' && action.type !== 'move-group') return
  suppressNextSelectionPageClick = true
  // 只吞掉拖拽结束时浏览器合成的那一次 click；不能让标记跨到用户下一次
  // 点击目标文件夹，否则目标会被选择模式拦截而无法导航。
  window.setTimeout(() => { suppressNextSelectionPageClick = false }, 0)
  void handleRuntimeMoveAction(action.type === 'move-group' ? action.objectIds : [action.objectId], action.toSurfaceId)
})

onUnmounted(() => {
  if (runtime.surfaces.get(runtimeBrowserSurfaceId)?.generation === browserSurfaceGeneration) {
    runtime.surfaces.unregister(runtimeBrowserSurfaceId, browserSurfaceGeneration)
  }
  // 不把列表视图的平面姿态泄漏给其它页面的 Runtime 卡片。
  syncFileDragRotation('grid')
})

const folderActions = useFileLibraryFolderActions({
  currentType, currentSeg, projectSeg, cacheStore, fileActions,
  loadContents, fetchStorage, pruneHistoryForFolders,
})
const {
  newFolderName, newFolderLoading, showNewFolderInput,
  createFolder, downloadFolder, deleteFolder,
} = folderActions

const folderInputRef = ref<HTMLInputElement | null>(null)
watch(showNewFolderInput, (v) => { if (v) nextTick(() => folderInputRef.value?.focus()) })

// ── 剪贴板 & 右键菜单 ────────────────────────────────────────────────────────
const isMac = navigator.platform.toUpperCase().includes('MAC') || navigator.userAgent.includes('Mac')
const modKey = isMac ? '⌘' : 'Ctrl'
// target 在 'folder' 菜单里读 .type 区分真实文件夹卡（f.type === 'folder'）与伪文件夹卡；
// FileMeta 本身没有 type 字段，补一个可选的，让联合类型上都能访问 .type（不影响运行时形状）。
type CtxTarget = (FileMeta & { type?: string }) | FolderCardMeta | null
const infoPopup = ref<{ show: boolean; file: FileMeta | undefined; x: number; y: number }>({ show: false, file: undefined, x: 0, y: 0 })

const contextActions = useFileLibraryContextActions<Exclude<CtxTarget, null>>({
  selectedFileIds: selectedIds,
  selectedFolderKeys,
  actions: {
    info: ctxInfo,
    download: ctxDownload,
    rename: ctxRename,
    cut: ctxCut,
    copy: ctxCopy,
    delete: ctxDelete,
    'download-folder': ctxDownloadFolder,
    'rename-folder': ctxRenameFolder,
    'cut-folder': ctxCutFolder,
    'copy-folder': ctxCopyFolder,
    'delete-folder': ctxDeleteFolder,
    'create-folder': () => { contextActions.close(); showNewFolderInput.value = true },
    paste: ctxPaste,
  },
})
const { state: ctx, openContext: openCtx, handleAction: handleCtxMenuAction } = contextActions
const gridViewContext = {
  contents, sortedContents, selectedFolderKeys, previewFolderKeys, inSelectionMode,
  openCtx, folderListIcon, folderAccentColor, handleFolderClick,
  renamingFolderKey, renameText, commitRename, cancelRename, startRenameFolder, downloadFolder,
  deleteFolder, selectedIds, previewFileIds, cbStore, handleFileClick,
  isImageExt, cardBlobReadyIds, renamingFileId, startRenameFile,
  downloadFile, deleteSingleFile, uploadingItems, canUpload, handleFileInput, loading,
  folderLayoutKey, fileLayoutKey,
  layoutCollection: 'files-browser',
}
const listViewContext = {
  contents, sortedContents, sortKey, sortDir, onSortSelect, openCtx, selectedFolderKeys,
  previewFolderKeys, handleFolderClick, folderListIcon,
  folderAccentColor, renamingFolderKey, renameText, commitRename, cancelRename,
  startRenameFolder, downloadFolder, deleteFolder, inSelectionMode, selectedIds,
  previewFileIds, cbStore, handleFileClick,
  fileListIcon, fileIconColor, renamingFileId, startRenameFile, downloadFile,
  deleteSingleFile, uploadingItems, loading, canUpload, handleFileInput,
  folderLayoutKey, fileLayoutKey,
  layoutCollection: 'files-browser',
}

function selCut() {
  batchActions.cutSelected()
}
function selCopy() {
  batchActions.copySelected()
}

// ── 文件操作 ──
function ctxInfo() {
  const f = ctx.value.target
  ctx.value.visible = false
  if (f) infoPopup.value = { show: true, file: f as FileMeta, x: ctx.value.x, y: ctx.value.y }
}

async function ctxDownload() {
  ctx.value.visible = false
  if (ctx.value.type !== 'multi-file' && !ctx.value.target) return
  const ids = ctx.value.type === 'multi-file'
    ? [...selectedIds.value]
    : [(ctx.value.target as FileMeta).id]
  if (ids.length === 1) {
    const f = sortedContents.value.files.find(f => f.id === ids[0])
    if (f) await fileActions.downloadFile(f)
  } else {
    const dirName = currentSeg.value?.name ?? t('files.file')
    await fileActions.batchDownload(ids, [], `${dirName}.zip`)
  }
}
function ctxRename() {
  const f = ctx.value.target; ctx.value.visible = false
  if (f) startRenameFile(f as FileMeta)
}
function ctxCut() {
  if (ctx.value.type !== 'multi-file' && !ctx.value.target) return
  const ids = ctx.value.type === 'multi-file'
    ? [...selectedIds.value] : [(ctx.value.target as FileMeta).id]
  cbStore.cut(ids, []); ctx.value.visible = false
}
function ctxCopy() {
  if (ctx.value.type !== 'multi-file' && !ctx.value.target) return
  const ids = ctx.value.type === 'multi-file'
    ? [...selectedIds.value] : [(ctx.value.target as FileMeta).id]
  cbStore.copy(ids, []); ctx.value.visible = false
}
async function ctxDelete() {
  ctx.value.visible = false
  if (ctx.value.type !== 'multi-file' && !ctx.value.target) return
  const ids = ctx.value.type === 'multi-file'
    ? [...selectedIds.value] : [(ctx.value.target as FileMeta).id]
  if (!await confirmFileDeletion(ids.length > 1 ? 'selected' : 'file', {
    count: ids.length,
    name: ctx.value.target && 'displayName' in ctx.value.target ? ctx.value.target.displayName : undefined,
  })) return
  // 乐观：先从缓存移除再 loadContents。loadContents 是从缓存同步重建的，若不先 removeFiles，n  // 被删文件仍在缓存 → 视图原地不动，要等 SSE/刷新才消失（跟 deleteSingleFile 对齐，之前这条右键路径漏了）。
  const backups = ids.map(id => cacheStore.getFile(id)).filter((f): f is FileMeta => f != null)
  await optimisticMutation({
    apply: () => {
      cacheStore.removeFiles(ids)
      selectedIds.value = new Set()
    },
    afterMutate: loadContents,
    work: () => Promise.all(ids.map(id => fileActions.deleteFile(id))),
    onCommit: fetchStorage,
    rollback: () => backups.forEach(f => cacheStore.addFile(f)),
    onError: e => console.error('[Files] 删除失败:', (e as Error).message),
  })
}

// ── 文件夹操作 ──
function ctxDownloadFolder() {
  const f = ctx.value.target; ctx.value.visible = false
  if (f) downloadFolder(f as FolderCardMeta)
}
function ctxRenameFolder() {
  const f = ctx.value.target; ctx.value.visible = false
  if (f) startRenameFolder(f as FolderCardMeta)
}
function ctxCutFolder() {
  if (!ctx.value.target) return
  cbStore.cut([], [(ctx.value.target as FolderCardMeta).folderId as number]); ctx.value.visible = false
}
function ctxCopyFolder() {
  if (!ctx.value.target) return
  cbStore.copy([], [(ctx.value.target as FolderCardMeta).folderId as number]); ctx.value.visible = false
}
async function ctxDeleteFolder() {
  const f = ctx.value.target; ctx.value.visible = false
  if (f) await deleteFolder(f as FolderCardMeta)
}

function ctxPaste() {
  ctx.value.visible = false
  return batchActions.paste()
}

// ── 键盘快捷键 ──
function onKeyDown(e: KeyboardEvent) {
  if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return
  const ctrl = e.ctrlKey || e.metaKey
  if (ctrl && e.key === 'x') {
    const fids = [...selectedIds.value]
    const dids = [...selectedFolderKeys.value]
      .map(k => contents.value.folders.find(f => f.id === k)?.folderId)
      .filter((id): id is number => id != null)
    if (fids.length || dids.length) { cbStore.cut(fids, dids); e.preventDefault() }
  } else if (ctrl && e.key === 'c') {
    const fids = [...selectedIds.value]
    if (fids.length) { cbStore.copy(fids, []); e.preventDefault() }
  } else if (ctrl && e.key === 'v') {
    if (cbStore.hasContent()) { batchActions.paste(); e.preventDefault() }
  }
}

onMounted(() => document.addEventListener('keydown', onKeyDown))
onUnmounted(() => document.removeEventListener('keydown', onKeyDown))
</script>

<style scoped>
.files-page {
  display: flex; flex-direction: column; gap: 14px;
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

/* 视图切换 */

.select-mode-btn {
  width: 28px; height: 28px; border-radius: 6px; border: none;
  background: rgba(0,0,0,0.05); cursor: pointer; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  transition: background 0.15s, color 0.15s, box-shadow 0.15s;
}
.select-mode-btn svg { display: block; }
.select-mode-btn.on {
  background: rgba(255,255,255,0.85);
  color: var(--color-primary);
  box-shadow: 0 1px 4px rgba(0,0,0,0.08);
}
.select-mode-btn:not(.on):hover { background: rgba(0,0,0,0.09); color: var(--text-primary); }

.paste-btn {
  display: flex; align-items: center; gap: 5px;
  height: 28px; padding: 0 12px; border-radius: 8px; border: none;
  background: rgba(255,255,255,0.55); cursor: pointer; color: var(--color-primary);
  font-size: 12px; font-weight: 600; font-family: var(--font-sans); white-space: nowrap;
  transition: background 0.15s, box-shadow 0.15s;
}
.paste-btn:hover { background: rgba(255,255,255,0.82); box-shadow: 0 1px 4px rgba(123,127,178,0.18); }
.paste-btn svg { display: block; }

.view-toggle {
  background: rgba(0,0,0,0.05);
  border-radius: 8px; padding: 2px; gap: 2px;
  flex-shrink: 0;
}
.view-toggle button {
  width: 28px; height: 28px; border-radius: 6px; border: none;
  background: none; cursor: pointer; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  transition: color 0.15s;
  flex-shrink: 0;
}
.view-toggle button svg { flex-shrink: 0; }
.view-toggle button.on { color: var(--color-primary); }

/* 新建文件夹 */
.new-folder-btn {
  display: flex; align-items: center; gap: 5px;
  height: 30px; padding: 0 12px; border-radius: 8px;
  border: 1px dashed rgba(0,0,0,0.15); background: rgba(255,255,255,0.5);
  font-size: 12px; font-weight: 600; color: var(--color-primary);
  cursor: pointer; font-family: var(--font-sans); transition: all 0.15s; white-space: nowrap;
}
.new-folder-btn:hover { border-color: var(--color-primary); background: rgba(123,127,178,0.06); }

.new-folder-row { display: flex; align-items: center; gap: 6px; }
.new-folder-input {
  height: 30px; padding: 0 10px; border-radius: 7px;
  border: 1.5px solid rgba(123,127,178,0.4); background: white;
  font-size: 12px; font-family: var(--font-sans); outline: none; width: 140px;
}
.new-folder-input:focus { border-color: var(--color-primary); }
.btn-confirm {
  height: 30px; padding: 0 12px; border-radius: 7px; border: none;
  background: linear-gradient(135deg, #7b7fb2, #9590c4); color: white;
  font-size: 12px; font-weight: 600; cursor: pointer;
}
.btn-confirm:disabled { opacity: 0.5; cursor: default; }
.btn-cancel {
  height: 30px; width: 30px; border-radius: 7px;
  border: 1px solid rgba(0,0,0,0.1); background: rgba(0,0,0,0.04);
  color: var(--text-secondary); font-size: 12px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}

/* ── 内容区 ── */
.files-body {
  flex: 1; min-height: 0; position: relative; overflow: hidden;
}

.files-main {
  height: 100%; padding: 16px; overflow-y: auto; overflow-x: hidden;
  box-sizing: border-box;
}

/* ── 框选矩形 ── */
.selection-rect {
  position: absolute; pointer-events: none; z-index: 30;
  border: 1.5px solid rgba(123,127,178,0.55);
  background: rgba(123,127,178,0.08);
  border-radius: 4px;
}

/* ── 框选拖拽中：禁用子元素 hover 动效。FileCard/FolderCard 的实体 paint 在各自组件。 ── */
.files-main.is-selecting .fc-card,
.files-main.is-selecting :deep(.folder-card) {
  pointer-events: none;
  transform: none !important;
  transition: none !important;
}

/* FilesGridView / FileCard / FilesTrashView 已各自拥有网格、卡片和回收站视觉；
   页面入口不再复制这些 selector，避免模块化后形成父 scoped root 与子组件双 owner。 */

/* ── 拖拽遮罩 ── */
.drop-overlay {
  position: absolute; inset: 0; z-index: 50;
  background: rgba(232,233,238,0.82);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  border-radius: inherit;
  corner-shape: inherit;
  display: flex; align-items: center; justify-content: center;
  pointer-events: none;
}
.drop-zone-hint {
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  padding: 40px 60px;
  background: rgba(255,255,255,0.72);
  border: 2px dashed rgba(123,127,178,0.45); border-radius: 20px;
  color: var(--color-primary);
}
.drop-hint { font-size: 16px; font-weight: 700; color: var(--text-primary); }

.drop-fade-enter-active, .drop-fade-leave-active { transition: opacity 0.18s; }
.drop-fade-enter-from, .drop-fade-leave-to { opacity: 0; }

.content-body { width: 100%; height: 100%; display: contents; }
</style>
