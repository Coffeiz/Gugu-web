<template>
  <FileBrowserPanel
    class="files-page"
    :can-paste="cbStore.hasContent() && currentType !== 'root' && currentType !== 'trash'"
    :paste-count="cbStore.fileIds.length + cbStore.folderIds.length"
    :selection-mode="inSelectionMode"
    :show-selection="currentType !== 'root'"
    :show-view-toggle="currentType !== 'trash'"
    :show-new-folder-button="currentType === 'personal' || currentType === 'project' || currentType === 'folder'"
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
    @sort-select="onSortSelect"
  >

    <template #breadcrumb>
      <FileBrowserBreadcrumb>
        <button class="nav-hist-btn" :disabled="!canGoBack" @click="goBack" title="后退">
          <PhArrowLeft :size="14" weight="bold" />
        </button>
        <button class="nav-hist-btn" :disabled="!canGoForward" @click="goForward" title="前进">
          <PhArrowRight :size="14" weight="bold" />
        </button>
        <button class="bc-item" :class="{ active: navPath.length === 0 }" @click="navigateTo(-1)">
          全部文件
        </button>
        <template v-for="(seg, i) in navPath" :key="i">
          <svg class="bc-arrow" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <path d="M3 2l4 3-4 3"/>
          </svg>
          <button class="bc-item"
            :class="{ active: i === navPath.length - 1, 'bc-drop-target': bcDragOverIdx === i && isBcDroppable(seg) }"
            :data-bc-idx="i"
            :ref="(el: any) => bindBreadcrumbEl(i, seg, el)"
            @click="navigateTo(i)"
          >
            <span v-if="seg.color" class="bc-dot" :style="{ background: seg.color }"></span>
            {{ seg.name }}
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
      <div class="files-main glass-card" ref="mainRef"
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

        <!-- ── 内容区：目录切换由 Runtime runLayoutMutation 驱动布局事务（Phase 4），
             不再用 Vue Transition + :key 整体销毁重建，卡片跨目录切换走 Collection
             Presence 进入/离场，而不是重挂载。 ── -->
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
import { ref, computed, watch, watchEffect, onMounted, onUnmounted, nextTick } from 'vue'
import type { TrashFolderMeta } from '@/services/api'
import FileUploadDropOverlay from '@/components/common/file-browser/FileUploadDropOverlay.vue'
import FileStorageUsage from '@/components/common/file-browser/FileStorageUsage.vue'
import FileTrashToolbarActions from '@/components/common/file-browser/FileTrashToolbarActions.vue'
import FilesTrashView from '@/views/Files/components/FilesTrashView.vue'
import FilesGridView from '@/views/Files/components/FilesGridView.vue'
import FilesListView from '@/views/Files/components/FilesListView.vue'
import FileBrowserBreadcrumb from '@/components/common/file-browser/FileBrowserBreadcrumb.vue'
import FileBrowserPanel from '@/components/common/file-browser/FileBrowserPanel.vue'
import FileBrowserContextMenu from '@/components/common/file-browser/FileBrowserContextMenu.vue'
import FileBrowserContextMenuContent from '@/components/common/file-browser/FileBrowserContextMenuContent.vue'
import FileInfoPopup from '@/components/common/FileInfoPopup.vue'
import FileSelectionToolbar from '@/components/common/FileSelectionToolbar.vue'
import { useClipboardStore } from '@/stores/clipboard'
import { uploadSignal } from '@/services/cache'
import { useProjectStore } from '@/stores/projects'
import { usePreviewStore, isPreviewable, isAudioExt } from '@/stores/preview'
import { fireHint } from '@/composables/useOnboarding'
import { useFilesCacheStore } from '@/stores/filesCache'
import { useUiStore } from '@/stores/ui'
import { cardBlobReadyIds } from '@/composables/useThumbCache'
import { vLazyThumb as vLazySrc } from '@/composables/useLazyThumb'
import { isImageExt, fileIconColor, fileListIcon } from '@/utils/fileTypes'
import { resolveFolderIds } from '@/utils/folderKeys'
import { splitName } from '@/utils/fileParse'
import { optimisticMutation } from '@/utils/optimisticMutation'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import { type NavSeg, type FolderCard as FolderCardMeta } from '@/utils/filesNav'
import { useFilesNav } from '@/composables/useFilesNav'
import { useFileLibraryNavigation } from '@/composables/files/useFileLibraryNavigation'
import { useFileLibraryDirectory } from '@/composables/files/useFileLibraryDirectory'
import { useFileDragDrop } from '@/composables/useFileDragDrop'
import { useFileLibrarySorting } from '@/composables/files/useFileLibrarySorting'
import { useFileLibrarySelection } from '@/composables/files/useFileLibrarySelection'
import { useFileLibraryBatchActions } from '@/composables/files/useFileLibraryBatchActions'
import { useFileLibraryTrashActions } from '@/composables/files/useFileLibraryTrashActions'
import { useSelectionState } from '@/composables/files/useSelectionState'
import { useFileActions } from '@/composables/files/useFileActions'
import { useFileLibraryContextActions } from '@/composables/files/useFileLibraryContextActions'
import { useFileLibraryUpload } from '@/composables/files/useFileLibraryUpload'
import { useFileLibraryRename } from '@/composables/files/useFileLibraryRename'
import { useFileStorageUsage } from '@/composables/files/useFileStorageUsage'
import { useFileLibraryFolderPresentation } from '@/composables/files/useFileLibraryFolderPresentation'
import { useFileLibraryFolderActions } from '@/composables/files/useFileLibraryFolderActions'
import { useFileLibraryFileActions } from '@/composables/files/useFileLibraryFileActions'
import { useSorting } from '@/composables/useSorting'
import UploadConflictDialog from '@/components/common/UploadConflictDialog.vue'
import { PhArrowLeft, PhArrowRight } from '@phosphor-icons/vue'
import { runtime, createVueRuntimeAdapter } from '@/interaction/runtime'
import {
  fileObjectId,
  browserSurfaceId as makeBrowserSurfaceId,
  folderSurfaceId,
  parseFolderSurfaceId,
  breadcrumbSurfaceId,
  parseBreadcrumbSurfaceId,
} from '@/interaction/runtime/adapters/file/fileRuntimeAdapter'

const projectStore = useProjectStore()
const cacheStore   = useFilesCacheStore()
const uiStore      = useUiStore()
const cbStore      = useClipboardStore()
const fileActions = useFileActions()

// ── 存储用量 ──
const { storageInfo, fetchStorage } = useFileStorageUsage()

// ── 视图状态 ──
// 使用模块级 cardBlobReadyIds：首次 @load 后写入，session 内二次访问直接显示跳过动画
const viewMode    = ref<'grid' | 'list'>('grid')
const loading     = ref(false)
const mainRef     = ref<HTMLElement | null>(null)
let directoryLoader: () => void = () => {}
function loadContents() { directoryLoader() }
// 状态文件夹的色 / 图标（待开始灰 / 进行中蓝 / 已完成绿）
const { folderIconStyle, folderListIcon, folderAccentColor } = useFileLibraryFolderPresentation()

// ── Runtime Core API：浏览区 Surface 与目录切换布局事务（Phase 4） ──
// 提前声明（早于 useFilesNav），因为 enterFolder/navigateTo/goBack/goForward 的包装
// 需要在传给下游 composable 之前就绪；domAdapter 本身只依赖 runtime 单例，不依赖任何
// 目录/内容状态，可以安全前移。
const RUNTIME_SCOPE = 'files'
const runtimeBrowserSurfaceId = makeBrowserSurfaceId(RUNTIME_SCOPE)
const domAdapter = createVueRuntimeAdapter(runtime)

// 乐观更新是即触发即生效的（onAction 里 void 掉，不等 API），业务数据一变，下面注册对象的
// watchEffect 马上就会看到这个文件/文件夹从当前目录的 sortedContents 里消失。落点确定后
// Runtime 几乎立刻就释放了这个对象的控制权（objectLease 在 emit() 后马上放，早于 landing/
// reveal 动画播完，是刻意设计，避免 <Teleport> 二次跳变），所以 runtime.isControlled() 在这
// 个时间点已经是 false，挡不住——真正要等的是"落地动画放完"，不是"控制权还在"。这里改成延迟
// 注销（见下方 unregister 循环），不是立刻同步注销，给动画留出时间窗口再真正从 Runtime 摘掉。

/** 当前浏览区内仍在被 Runtime 拖拽控制的卡片：导航期间不能销毁它们的事务态。 */
function hasActiveMove(): boolean {
  const root = mainRef.value
  if (!root) return false
  const cards = root.querySelectorAll<HTMLElement>('[data-layout-role="card"]')
  for (const card of cards) {
    const key = card.dataset.layoutKey
    if (key && runtime.isControlled(key)) return true
  }
  return false
}

/**
 * 目录切换的布局事务包装（Phase 4）：先量当前可见卡片的位置，执行状态 mutate，
 * 等 Vue 完成 DOM patch，再播放 FLIP/Collection Presence——取代旧的
 * `<Transition mode="out-in">` 整体销毁重建。拖拽进行中拒绝导航（对齐 demo 的
 * hasActiveMove 守卫）。
 */
async function withLayoutNav(mutate: () => void): Promise<void> {
  if (hasActiveMove()) return
  const root = mainRef.value
  if (!root) {
    mutate()
    return
  }
  const elements = Array.from(root.querySelectorAll<HTMLElement>('[data-layout-role="card"]'))
  await domAdapter.runLayoutMutation({
    elements,
    root,
    mutate,
    waitForPatch: () => nextTick(),
  })
}

// ── 导航 ──
const {
  navPath, canGoBack, canGoForward,
  goBack: rawGoBack, goForward: rawGoForward,
  currentType, currentSeg, projectSeg, canUpload,
  saveNav, enterFolder: rawEnterFolder, navigateTo: rawNavigateTo, restoreNav, pruneHistoryForFolders,
} = useFilesNav({ loadContents, clearSelection })

function enterFolder(folder: FolderCardMeta): void { void withLayoutNav(() => rawEnterFolder(folder)) }
function navigateTo(idx: number): void { void withLayoutNav(() => rawNavigateTo(idx)) }
function goBack(): void { void withLayoutNav(() => rawGoBack()) }
function goForward(): void { void withLayoutNav(() => rawGoForward()) }

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
  fireHint('file_lib')   // 新手引导：第一次进文件库
  fetchStorage()
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
// 刷新/patch 的决策与「回声抑制」全在 filesCache 里统一做（见 filesCache.ts fileEvent 消费）；本页不再自己
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
  onContainerMouseDown: _boxMouseDown, cancelDrag: _cancelBoxDrag,
  clearSelection: clearSelectionImpl, flatSelectableItems, inSelectionMode, selectModeForced,
  toggleSelectMode, toggleSelectAllTrash, allTrashSelected,
  handleFolderClick, handleFileClick, handleTrashFileClick, handleTrashFolderClick,
} = selection
function clearSelection() { clearSelectionImpl() }

function onMainMouseDown(e: MouseEvent) {
  if (currentType.value === 'root' || currentType.value === 'projects') return
  _boxMouseDown(e)
}

function onPageClick() {
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
const { uploadingItems, uploadFiles, handleFileInput, onDragEnter, onDragLeave, handleDrop, isDragging } = fileUpload

// ── 预览 ──
const previewStore = usePreviewStore()
const openPreview = (f: FileMeta) => {
  if (isAudioExt(f.ext)) fireHint('music')   // 新手引导：第一次打开音乐文件（🎵😌 彩蛋）
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
// perf trace 实测证实）。抓取判断单选/多选 → 起 startPhysicsDrag/startMultiPhysicsDrag → 拖拽
// 中找落点高亮 → 松手判定目标并派发移动，这套编排跟 ProjectModal.vue 的文件面板完全一样，抽成
// 了共享 composable useFileDragDrop，这里只提供 Files 特有的选择器/面包屑规则/落地 API。
function isBcDroppable(seg: NavSeg) {
  // folder/personal/project 段都可作为拖放目标：folder→该文件夹，personal/project→对应根（parentId=null，
  // resolveBcTarget 里非 folder 段一律映射为 null）。此前漏了 project，导致子目录文件夹拖不回项目根。
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

const {
  draggingFileIds, draggingFolderIds, dragOverFolderId, bcDragOverIdx,
  onFolderPointerDown: _onFolderPointerDown, onFilePointerDown: _onFilePointerDown,
} = useFileDragDrop({
  fileDataAttr: 'data-file-id',
  // data-folder-key 存的是 f.id（"f:65" 这种带前缀字符串，框选那套逻辑要靠它跟 selectedFolderKeys
  // 对上），不是真实数字 folderId——拖拽这边要拿去拼 API/跟面包屑 folderId 比较，得用另一个只放
  // 数字 folderId 的属性，两套别混用（混用过一次：Number("f:65") 是 NaN，导致移动全部落空）。
  folderDataAttr: 'data-folder-id',
  folderSelector: '.folder-card, .folder-row',
  resolveBcTarget(idx) {
    if (idx === navPath.value.length - 1) return null   // 当前目录本身，拖回来不算有效落点
    const seg = navPath.value[idx]
    if (!seg || !isBcDroppable(seg)) return null
    return { targetFolderId: seg.type === 'folder' ? (seg.folderId ?? null) : null, acceptsFiles: true, acceptsFolders: true }
  },
  cancelBoxDrag: () => _cancelBoxDrag(),
  // 之前这里只清 selectedFolderKeys/selectedIds 两个 Set，没重置 selectModeForced——多选拖拽
  // 落地后 inSelectionMode 仍然是 true，紧接着点文件夹卡片会被判成"多选模式下切换选中"而不是
  // "进入文件夹"（handleFolderClick 里 `inSelectionMode.value` 分支优先于 enterFolder）。改用
  // 上面定义的完整 clearSelection()（转发到 useFileLibrarySelection 的 clearSelectionImpl，
  // 一并重置 selectModeForced 和框选状态），跟右键菜单、批量操作等其它清空选择的入口保持一致。
  clearSelection,
  moveFolders: moveFoldersInto,
  moveFiles: moveFilesInto,
})

// selectedFolderKeys 里放的是 f.id（"f:65"），拖拽需要真实数字 folderId——查当前层文件夹列表换算
function _selectedFolderIdNums() {
  return new Set(resolveFolderIds(selectedFolderKeys.value, sortedContents.value.folders))
}

// 与 useFileDragDrop.ts _startCardDrag 里的 isMulti 判断完全一致：这张卡此刻处于选中态，且
// 自己这一类（文件夹/文件）的选区非空。只有这个条件为真时，旧的 pointer 拖拽编排才接管——
// 单选场景交给下面的 Runtime Core API 对象（abilities 含 'move'）独占 pointerdown，避免
// 同一次抓取被两套 session 同时接管。
function isFolderRoutedToLegacyDrag(folderKey: string): boolean {
  return selectedFolderKeys.value.has(folderKey) && _selectedFolderIdNums().size > 0
}
function isFileRoutedToLegacyDrag(fileId: number): boolean {
  return selectedIds.value.has(fileId) && selectedIds.value.size > 0
}

function onFolderPointerDown(f: FolderCardMeta, e: PointerEvent) {
  // 全部文件根目录下"个人文件/项目文件/回收站"是伪文件夹卡片（type 不是 'folder'，没有真实
  // folderId），不能拖拽——之前没挡，f.folderId 是 undefined，落点判定/吸入动画照样能触发
  // （只是数据层最终 API 调用会因 id 无效而静默失败），表现为"能拖进别的卡片，但只有动画有效果"。
  if (f.type !== 'folder' || f.folderId == null) return
  // 单选（未参与多选）时这张卡在 Runtime 里注册了 abilities:['move']，pointerdown 已经被
  // Runtime 接管，旧编排不再重复起一份 session。
  if (!isFolderRoutedToLegacyDrag(f.id)) return
  _onFolderPointerDown(e, {
    itemId: f.folderId,
    isSelected: selectedFolderKeys.value.has(f.id),
    selectedFileIds: selectedIds.value,
    selectedFolderIds: _selectedFolderIdNums(),
    // landing 需要盖过文件工具栏/面包屑（工具栏 z-index:20），否则飞回面包屑时会被裁在其后。
    extraOpts: { dragZIndex: 31 },
  })
}
function onFilePointerDown(f: FileMeta, e: PointerEvent) {
  if (!isFileRoutedToLegacyDrag(f.id)) return
  _onFilePointerDown(e, {
    itemId: f.id,
    isSelected: selectedIds.value.has(f.id),
    selectedFileIds: selectedIds.value,
    selectedFolderIds: _selectedFolderIdNums(),
    extraOpts: { dragZIndex: 31 },
  })
}

// ── Runtime Core API 单卡接入（Phase 1） ──
// 单文件/单文件夹拖拽完全交给 Interaction Runtime：这里只做 3.2 节允许的事——注册
// 对象/Surface/Target、同步 DOM ref、订阅 onAction 后转发进现有的 moveFoldersInto/
// moveFilesInto（乐观更新、回滚、409 处理都不变）。多选继续走上面的 useFileDragDrop。
// RUNTIME_SCOPE / runtimeBrowserSurfaceId / domAdapter 已在文件靠前处声明（Phase 4 需要
// 提前给 withLayoutNav 使用）。

function folderLayoutKey(f: FolderCardMeta): string {
  // 真实文件夹卡复用 Phase 1 已全局唯一的 fileObjectId；伪文件夹卡（个人文件/项目/状态分组
  // 等非 Runtime Object）没有该 id，仍需要一个全局唯一的 layout key 才能参与目录切换的
  // Collection Presence 兄弟卡 FLIP，用固定前缀 + f.id 兜底。
  return f.type === 'folder' && f.folderId != null
    ? fileObjectId(RUNTIME_SCOPE, 'folder', f.folderId)
    : `${RUNTIME_SCOPE}:pseudo-folder:${f.id}`
}
function fileLayoutKey(f: FileMeta): string {
  return fileObjectId(RUNTIME_SCOPE, 'file', f.id)
}

function bindFolderEl(f: FolderCardMeta, target: unknown) {
  if (f.type !== 'folder' || f.folderId == null) return
  const el = (target as { rootEl?: HTMLElement | null } | HTMLElement | null)
  const element = el && typeof el === 'object' && 'rootEl' in el ? (el as { rootEl: HTMLElement | null }).rootEl : (el as HTMLElement | null)
  domAdapter.bindObject(fileObjectId(RUNTIME_SCOPE, 'folder', f.folderId), element ?? null)
}
function bindFileEl(f: FileMeta, target: unknown) {
  const el = (target as { rootEl?: HTMLElement | null } | HTMLElement | null)
  const element = el && typeof el === 'object' && 'rootEl' in el ? (el as { rootEl: HTMLElement | null }).rootEl : (el as HTMLElement | null)
  domAdapter.bindObject(fileObjectId(RUNTIME_SCOPE, 'file', f.id), element ?? null)
}
function bindBreadcrumbEl(idx: number, seg: NavSeg, element: HTMLElement | null) {
  if (!isBcDroppable(seg)) return
  const surfaceId = breadcrumbSurfaceId(RUNTIME_SCOPE, idx)
  domAdapter.bindTarget(`bc:${idx}`, { surfaceId, accepts: ['file-item', 'folder-item'], priority: 1 }, element)
}

interface ObjectRegSnapshot { type: string; surfaceId: string; abilities: string[] }
const objectGenerations = new Map<string, number>()
const objectSnapshots = new Map<string, ObjectRegSnapshot>()
const runtimeSurfaceIds = new Set<string>()
// 对象离开当前目录视图后不立刻注销，改成延迟到落地动画时长之后（见下方 unregister 循环）；
// 这里记录已排期的定时器，避免同一个 id 重复排期，对象重新出现在视图里时要能取消排期。
const pendingUnregisterTimers = new Map<string, ReturnType<typeof setTimeout>>()
// 配置里最长的 landing 时长（target 落地 300ms）+ 余量，动画放完之后再摘注册，不提前抢跑。
const UNREGISTER_DELAY_MS = 500

watchEffect(() => {
  const nextObjectIds = new Set<string>()
  const folders = sortedContents.value.folders.filter(f => f.type === 'folder' && f.folderId != null)
  const files = sortedContents.value.files

  for (const f of folders) {
    const id = fileObjectId(RUNTIME_SCOPE, 'folder', f.folderId as number)
    const abilities = isFolderRoutedToLegacyDrag(f.id) ? [] : ['move']
    const surfaceId = runtimeBrowserSurfaceId
    nextObjectIds.add(id)
    const snapshot: ObjectRegSnapshot = { type: 'folder-item', surfaceId, abilities }
    const prev = objectSnapshots.get(id)
    const changed = !prev || prev.type !== snapshot.type || prev.surfaceId !== snapshot.surfaceId
      || prev.abilities.length !== snapshot.abilities.length || prev.abilities[0] !== snapshot.abilities[0]
    if (changed) {
      objectGenerations.set(id, runtime.objects.register({
        id,
        type: 'folder-item',
        surfaceId,
        element: runtime.objects.get(id)?.element ?? null,
        abilities,
        target: { surfaceId: folderSurfaceId(RUNTIME_SCOPE, f.folderId as number), accepts: ['file-item', 'folder-item'], priority: 2 },
      }))
      objectSnapshots.set(id, snapshot)
    }
  }

  for (const f of files) {
    const id = fileObjectId(RUNTIME_SCOPE, 'file', f.id)
    const abilities = isFileRoutedToLegacyDrag(f.id) ? [] : ['move']
    const surfaceId = runtimeBrowserSurfaceId
    nextObjectIds.add(id)
    const snapshot: ObjectRegSnapshot = { type: 'file-item', surfaceId, abilities }
    const prev = objectSnapshots.get(id)
    const changed = !prev || prev.type !== snapshot.type || prev.surfaceId !== snapshot.surfaceId
      || prev.abilities.length !== snapshot.abilities.length || prev.abilities[0] !== snapshot.abilities[0]
    if (changed) {
      objectGenerations.set(id, runtime.objects.register({
        id,
        type: 'file-item',
        surfaceId,
        element: runtime.objects.get(id)?.element ?? null,
        abilities,
      }))
      objectSnapshots.set(id, snapshot)
    }
  }

  for (const [id, generation] of objectGenerations) {
    if (nextObjectIds.has(id)) {
      // 对象重新出现在当前目录视图里（比如乐观更新后又撤销/刷新拉回原状）：取消排期的注销。
      const pending = pendingUnregisterTimers.get(id)
      if (pending) { clearTimeout(pending); pendingUnregisterTimers.delete(id) }
      continue
    }
    if (pendingUnregisterTimers.has(id)) continue // 已经排过队，不用重复排
    pendingUnregisterTimers.set(id, setTimeout(() => {
      pendingUnregisterTimers.delete(id)
      if (runtime.objects.get(id)?.generation === generation) runtime.objects.unregister(id)
      objectGenerations.delete(id)
      objectSnapshots.delete(id)
    }, UNREGISTER_DELAY_MS))
  }

  // Surface：浏览区是稳定的单一 Surface（绑定在 watchEffect 外，见下方 onMounted）；
  // 文件夹自己的语义 Surface 和面包屑语义 Surface 只用来承接 Target，不对应真实容器 DOM。
  const nextSurfaceIds = new Set<string>([runtimeBrowserSurfaceId])
  for (const f of folders) nextSurfaceIds.add(folderSurfaceId(RUNTIME_SCOPE, f.folderId as number))
  navPath.value.forEach((seg, i) => { if (isBcDroppable(seg)) nextSurfaceIds.add(breadcrumbSurfaceId(RUNTIME_SCOPE, i)) })
  for (const id of nextSurfaceIds) {
    if (!runtime.surfaces.has(id)) runtime.surfaces.register({
      id,
      type: id === runtimeBrowserSurfaceId ? 'file-browser' : id.includes(':breadcrumb:') ? 'file-breadcrumb' : 'file-folder',
      element: null,
      accepts: ['file-item', 'folder-item'],
    })
    runtimeSurfaceIds.add(id)
  }
  for (const id of runtimeSurfaceIds) {
    if (nextSurfaceIds.has(id)) continue
    runtime.surfaces.unregister(id)
    runtimeSurfaceIds.delete(id)
  }
})

async function handleRuntimeMoveAction(objectId: string, toSurfaceId: string) {
  const isFolder = objectId.startsWith(`${RUNTIME_SCOPE}:folder:`)
  const isFile = objectId.startsWith(`${RUNTIME_SCOPE}:file:`)
  if (!isFolder && !isFile) return
  const rawId = objectId.slice(objectId.lastIndexOf(':') + 1)
  const id = Number(rawId)
  if (Number.isNaN(id)) return

  if (toSurfaceId === runtimeBrowserSurfaceId) return // 落回浏览区本身：不算移动

  let targetFolderId: number | null
  const folderTarget = parseFolderSurfaceId(RUNTIME_SCOPE, toSurfaceId)
  if (folderTarget !== null) {
    targetFolderId = Number(folderTarget)
    if (Number.isNaN(targetFolderId)) return
    if (isFolder && targetFolderId === id) return // 拖到自己身上
  } else {
    const idx = parseBreadcrumbSurfaceId(RUNTIME_SCOPE, toSurfaceId)
    if (idx === null) return
    const seg = navPath.value[idx]
    if (!seg || !isBcDroppable(seg)) return
    targetFolderId = seg.type === 'folder' ? (seg.folderId ?? null) : null
  }

  selectedFolderKeys.value = new Set()
  selectedIds.value = new Set()
  if (isFolder) await moveFoldersInto([id], targetFolderId)
  else await moveFilesInto([id], targetFolderId)
}

const stopRuntimeAction = runtime.onAction(action => {
  if (action.type !== 'move') return
  void handleRuntimeMoveAction(action.objectId, action.toSurfaceId)
})

onMounted(() => {
  // 浏览区绑到 .files-main（mainRef）本身：它在 <Transition mode="out-in"> 之外，
  // 目录切换只替换里面的 .content-body，不会销毁这个交互根节点。
  domAdapter.bindSurface(runtimeBrowserSurfaceId, mainRef.value)
})
watch(mainRef, el => domAdapter.bindSurface(runtimeBrowserSurfaceId, el))

onUnmounted(() => {
  stopRuntimeAction()
  for (const timer of pendingUnregisterTimers.values()) clearTimeout(timer)
  pendingUnregisterTimers.clear()
  for (const [id, generation] of objectGenerations) {
    if (runtime.objects.get(id)?.generation === generation) runtime.objects.unregister(id)
  }
  for (const id of runtimeSurfaceIds) runtime.surfaces.unregister(id)
  domAdapter.dispose()
})

const folderActions = useFileLibraryFolderActions({
  currentType, currentSeg, projectSeg, cacheStore, fileActions,
  loadContents, fetchStorage, pruneHistoryForFolders,
})
const {
  newFolderName, newFolderLoading, showNewFolderInput,
  createFolder, downloadFolder, deleteFolder,
} = folderActions

// ── 样式工具 ──
// 文件类型助手（isImageExt / fileExtCategory / fileIconColor / fileListIcon）与缩略图懒加载指令
// vLazySrc 已统一收口到 @/utils/fileTypes 和 @/composables/useLazyThumb，见顶部 import。

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
  contents, sortedContents, selectedFolderKeys, previewFolderKeys, dragOverFolderId, inSelectionMode,
  openCtx, folderListIcon, folderAccentColor, handleFolderClick, onFolderPointerDown,
  renamingFolderKey, renameText, commitRename, cancelRename, startRenameFolder, downloadFolder,
  deleteFolder, selectedIds, previewFileIds, draggingFileIds, cbStore, handleFileClick,
  onFilePointerDown, isImageExt, cardBlobReadyIds, renamingFileId, startRenameFile,
  downloadFile, deleteSingleFile, uploadingItems, canUpload, handleFileInput, loading,
  bindFolderEl, bindFileEl, folderLayoutKey, fileLayoutKey, layoutCollection: 'files-browser',
}
const listViewContext = {
  contents, sortedContents, sortKey, sortDir, onSortSelect, openCtx, selectedFolderKeys,
  previewFolderKeys, dragOverFolderId, handleFolderClick, onFolderPointerDown, folderListIcon,
  folderAccentColor, renamingFolderKey, renameText, commitRename, cancelRename,
  startRenameFolder, downloadFolder, deleteFolder, inSelectionMode, selectedIds,
  previewFileIds, draggingFileIds, cbStore, handleFileClick, onFilePointerDown,
  fileListIcon, fileIconColor, renamingFileId, startRenameFile, downloadFile,
  deleteSingleFile, uploadingItems, loading, canUpload, handleFileInput,
  bindFolderEl, bindFileEl, folderLayoutKey, fileLayoutKey, layoutCollection: 'files-browser',
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
    const dirName = currentSeg.value?.name ?? '文件'
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
  // 乐观：先从缓存移除再 loadContents。loadContents 是从缓存同步重建的，若不先 removeFiles，
  // 被删文件仍在缓存 → 视图原地不动，要等 SSE/刷新才消失（跟 deleteSingleFile 对齐，之前这条右键路径漏了）。
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

/* 顶栏搜索定位到的文件：短暂高亮 */
.search-flash {
  animation: search-flash 1.8s ease;
  border-radius: var(--radius-sm);
}
@keyframes search-flash {
  0%, 60%  { box-shadow: 0 0 0 2px var(--color-primary), 0 0 14px rgba(123,127,178,0.55); }
  100%     { box-shadow: 0 0 0 0 rgba(123,127,178,0); }
}

/* ── 工具栏 ── */
.files-toolbar {
  display: flex; align-items: center; justify-content: space-between;
  height: 52px; box-sizing: border-box;
  padding: 0 16px; flex-shrink: 0; gap: 12px;
  position: relative; z-index: 20;
}
.toolbar-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

/* 面包屑 */
.breadcrumb {
  display: flex; align-items: center; gap: 4px;
  flex: 1; min-width: 0; overflow: hidden;
}
.nav-hist-btn {
  display: flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border-radius: 7px; border: none;
  background: none; cursor: pointer; color: var(--text-secondary);
  transition: all 0.13s; flex-shrink: 0;
}
.nav-hist-btn:hover:not(:disabled) { background: rgba(0,0,0,0.05); color: var(--text-primary); }
.nav-hist-btn:disabled { opacity: 0.28; cursor: default; }
.bc-item {
  display: flex; align-items: center; gap: 5px;
  padding: 4px 8px; border-radius: 7px; border: none;
  background: none; cursor: pointer;
  font-size: 12px; font-weight: 500; color: var(--text-secondary);
  font-family: var(--font-sans); transition: all 0.13s;
  white-space: nowrap; flex-shrink: 0;
}
.bc-item:hover { background: rgba(0,0,0,0.05); color: var(--text-primary); }
.bc-item.active { color: var(--text-primary); font-weight: 600; cursor: default; }
.bc-item.active:hover { background: none; }
.bc-item.bc-drop-target { background: rgba(123,127,178,0.15); color: var(--color-primary); }
.bc-arrow { color: var(--text-secondary); opacity: 0.4; flex-shrink: 0; }
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
  flex-shrink: 0;   /* 工具栏拥挤时不被挤压，否则按钮/带 viewBox 的 SVG 会缩成 2~3px（首屏/久置后布局最紧时最明显）*/
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
  height: 100%; padding: 16px; overflow-y: auto;
  box-sizing: border-box;
}

/* ── 框选矩形 ── */
.selection-rect {
  position: absolute; pointer-events: none; z-index: 30;
  border: 1.5px solid rgba(123,127,178,0.55);
  background: rgba(123,127,178,0.08);
  border-radius: 4px;
}

/* ── 框选拖拽中：禁用子元素 hover 动效 ── */
.files-main.is-selecting .fc-card,
.files-main.is-selecting :deep(.folder-card) {
  pointer-events: none;
  transform: none !important;
  transition: none !important;
}

/* ── 预选中状态（拖拽未松开） ── */
.fc-card.pre-selected {
  border-color: rgba(123,127,178,0.45);
  background: rgba(123,127,178,0.06);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.85), 0 0 0 1.5px rgba(123,127,178,0.15);
}
.list-row.pre-selected {
  background: rgba(123,127,178,0.06);
  outline: 1px solid rgba(123,127,178,0.25);
}

.list-row.folder-row.selected {
  background: rgba(123,127,178,0.09);
}

/* ── 网格 ── */
.file-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(158px, 1fr));
  gap: 10px;
  align-content: start;
}

.grid-empty {
  display: flex; flex-direction: column; align-items: center;
  gap: 10px; padding: 72px 0;
  font-size: 12px; color: var(--text-secondary); opacity: 0.5;
}

/* ── 文件卡片 ──
   底色/边框/hover/选中态/缩略图区/大图标/标题元信息这些基础视觉已抽到
   components/common/FileCard.vue（含 :hover 的 box-shadow/background，跟全局
   .hover-card-fx 的位移动效分工一致），这里只留本页专属的选择框/悬浮操作等交互态样式。 */
.sel-checkbox {
  position: absolute; top: 8px; right: 8px; z-index: 3;
  width: 18px; height: 18px; border-radius: 5px;
  border: 2px solid rgba(123, 127, 178, 0.55);
  background: rgba(255,255,255,0.75);
  display: flex; align-items: center; justify-content: center;
  transition: background 0.15s, border-color 0.15s;
  pointer-events: none;
}
.sel-checkbox.checked {
  background: var(--color-primary, #7b7fb2);
  border-color: var(--color-primary, #7b7fb2);
}
.lr-actions { position: relative; }
.lr-actions .sel-checkbox {
  position: absolute;
  right: 0; top: 50%; transform: translateY(-50%);
  background: rgba(255,255,255,0.55);
  transition: background 0.15s, border-color 0.15s, opacity 0.18s ease;
}
.lr-actions .sel-checkbox.checked {
  background: var(--color-primary, #7b7fb2);
  border-color: var(--color-primary, #7b7fb2);
}
/* 勾选框出现/消失动画 */
.sel-cb-enter-active,
.sel-cb-leave-active { transition: background 0.15s, border-color 0.15s, opacity 0.18s ease; }
.sel-cb-enter-from,
.sel-cb-leave-to { opacity: 0; }

.fc-ext-badge {
  position: absolute; top: 10px; left: 10px; z-index: 2;
  font-size: 8px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase;
  color: var(--fc-color, var(--color-primary));
  background: rgba(0,0,0,0.04);
  border-radius: 4px; padding: 2px 5px; line-height: 1.5;
}

/* 大图标区 */
.fc-icon-area {
  height: 90px;
  flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  overflow: visible;
}
.fc-big-icon {
  width: 86px; height: 86px;
  color: var(--fc-color, var(--color-primary));
  opacity: 0.55;
  transform: translateY(20px);
  mask-image: linear-gradient(to bottom, black 0%, black 35%, rgba(0,0,0,0.62) 62%, rgba(0,0,0,0.22) 80%, transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, black 0%, black 35%, rgba(0,0,0,0.62) 62%, rgba(0,0,0,0.22) 80%, transparent 100%);
  flex-shrink: 0;
}

/* .fc-thumb-area 基础布局（含选中态叠加）+ img 的 position/object-fit 已挪进
   FileCard.vue（`.fc-thumb-area :deep(img)`）；这里只留缩略图两层（模糊占位 tiny + 淡入
   full）本页专属的图层差异，它们是 #thumb 插槽里的内容。 */
/* tiny：模糊放大填满，作为永久底层 */
.fc-thumb-tiny {
  filter: blur(10px);
  transform: scale(1.15);
  z-index: 1;
}
/* full：初始透明，加载完淡入覆盖 tiny */
.fc-thumb-full {
  z-index: 2;
  opacity: 0;
  transition: opacity 0.4s ease;
}
.fc-thumb-full.fc-loaded { opacity: 1; }

/* 底部标签（幽灵上传卡专属——真实文件卡的标签视觉已挪进 FileCard.vue） */
.fc-label { padding: 0 13px 13px; }
.fc-name {
  font-size: 11.5px; font-weight: 600; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  line-height: 1.35; padding-bottom: 2px; margin-bottom: -2px;
}
.fc-meta { font-size: 9px; color: var(--text-secondary); opacity: 0.55; margin-top: 2px; }

.fc-hover-actions {
  position: absolute; top: 8px; right: 8px; z-index: 2;
  display: flex; gap: 3px; opacity: 0; transition: opacity 0.15s;
}
.fc-card:hover .fc-hover-actions { opacity: 1; }

/* .rename-sizer / .rename-ghost / .rename-input-inline 已提到 global.css（全站重命名输入框共用） */

/* ── 拖动状态（.fc-card.dragging 已挪进 FileCard.vue，这里只留列表行） ── */
.list-row.dragging { opacity: 0.35; cursor: grabbing; }
.list-row.folder-row.drag-over {
  background: rgba(123,127,178,0.08);
  outline: 1.5px solid var(--color-primary); outline-offset: -1px;
}

/* 网格/列表上传按钮外观改由共用组件 FileUploadButton.vue 提供（跟项目文件区同一份）。 */

/* ── 列表视图 ── */
.file-list { display: flex; flex-direction: column; gap: 2px; }

.lh-sortable {
  display: flex; align-items: center; gap: 3px;
  cursor: pointer; user-select: none; transition: color 0.12s;
}
.lh-sortable:hover { color: var(--text-primary); }
.lh-sortable.active { color: var(--color-primary); }
.lh-arrow { opacity: 0; flex-shrink: 0; transition: opacity 0.15s, transform 0.2s; }
.lh-sortable.active .lh-arrow { opacity: 1; }
.lh-arrow.desc { transform: rotate(180deg); }

.list-head {
  display: grid;
  grid-template-columns: 2fr 90px 1.2fr 80px 72px 56px;
  padding: 0 10px 8px;
  font-size: 10px; font-weight: 600; color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: 0.06em;
  border-bottom: 1px solid rgba(0,0,0,0.06); margin-bottom: 2px;
}
.list-row {
  display: grid;
  grid-template-columns: 2fr 90px 1.2fr 80px 72px 56px;
  align-items: center; padding: 9px 10px;
  min-height: 42px;
  border-radius: 9px; transition: background 0.12s;
  cursor: pointer;
}
.list-row:hover { background: rgba(123,127,178,0.06); }
.list-row.selected { background: rgba(123,127,178,0.1); }
.folder-row { cursor: pointer; }
.folder-row:hover { background: rgba(180,148,80,0.06); }

.lr-name-cell { display: flex; align-items: center; gap: 7px; min-width: 0; }
.lr-folder-icon, .lr-file-icon { flex-shrink: 0; opacity: 0.82; }
.lr-type-cell { display: flex; align-items: center; gap: 5px; min-width: 0; }
.lr-ext {
  font-size: 8px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase;
  border-radius: 3px; padding: 1px 4px; flex-shrink: 0; line-height: 1.5;
}
.lr-type-text { font-size: 11px; color: var(--text-secondary); }
.lr-filename {
  font-size: 12px; font-weight: 600; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  flex: 1; min-width: 0; padding-bottom: 2px; margin-bottom: -2px;
}
.lr-proj-cell { display: flex; align-items: center; gap: 6px; min-width: 0; }
.lr-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; opacity: 0.8; }
.lr-projname {
  font-size: 11px; color: var(--text-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  padding-bottom: 2px; margin-bottom: -2px;
}
.lr-text { font-size: 11px; color: var(--text-secondary); }

.lr-actions { display: flex; align-items: center; justify-content: flex-end; gap: 2px; }
.list-row:hover .file-list-btn { opacity: 1; }

.list-empty {
  display: flex; flex-direction: column; align-items: center;
  gap: 8px; padding: 56px 0; color: var(--text-secondary); font-size: 12px; opacity: 0.5;
}

/* ── 回收站视图 ── */
.trash-list .list-head,
.trash-list .list-row { grid-template-columns: 2fr 90px 1.2fr 56px 72px 96px; }

.days-warn { color: #c85a5a; font-weight: 600; }

.trash-restore-btn {
  width: auto; display: flex; align-items: center; gap: 4px;
  font-size: 11px; font-weight: 600;
  color: var(--color-primary);
  padding: 4px 8px;
}
.trash-restore-btn:hover { background: rgba(123,127,178,0.15); }
.trash-expand-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 18px; height: 18px; padding: 0; border: 0; background: transparent;
  color: var(--text-secondary); cursor: pointer;
}
.trash-expand-btn svg { transform: rotate(-90deg); transition: transform .18s ease; }
.trash-expand-btn svg.rotated { transform: rotate(0deg); }
.trash-folder-contents { margin: -3px 0 5px 34px; padding: 4px 0 5px 14px; border-left: 1px solid rgba(130,135,170,.22); }
.trash-child-row { display: flex; align-items: center; gap: 7px; min-height: 28px; color: var(--text-secondary); font-size: 11px; }
.trash-child-row svg { color: var(--color-primary); flex: 0 0 auto; }
.trash-child-row small { margin-left: auto; margin-right: 12px; opacity: .65; }
.trash-child-row.file svg { color: var(--text-tertiary); }
.trash-folder-empty { color: var(--text-tertiary); font-size: 11px; padding: 5px 0; }

/* ── 批量操作浮动栏 ── */
.selection-bar {
  position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 10px;
  padding: 10px 16px; border-radius: 14px;
  background: rgba(30,32,44,0.88);
  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 8px 32px rgba(0,0,0,0.22);
  z-index: 100;
}
.sel-count { font-size: 12px; color: rgba(255,255,255,0.75); white-space: nowrap; }
.sel-download-btn {
  display: flex; align-items: center; gap: 5px;
  padding: 6px 12px; border-radius: 8px; border: none;
  background: rgba(255,255,255,0.15); color: white;
  font-size: 12px; font-weight: 600; cursor: pointer; transition: background 0.15s;
}
.sel-download-btn:hover { background: rgba(255,255,255,0.25); }
.sel-download-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
/* ── 右键菜单（.fc-card.cut 已挪进 FileCard.vue，这里只留列表行） ── */
.list-row.cut { opacity: 0.45; }
.sel-delete-btn {
  display: flex; align-items: center; gap: 5px;
  padding: 6px 12px; border-radius: 8px; border: none;
  background: rgba(200,90,90,0.85); color: white;
  font-size: 12px; font-weight: 600; cursor: pointer; transition: background 0.15s;
}
.sel-delete-btn:hover { background: rgba(200,90,90,1); }
.sel-cancel-btn {
  padding: 6px 10px; border-radius: 8px; border: none;
  background: rgba(255,255,255,0.12); color: rgba(255,255,255,0.7);
  font-size: 12px; cursor: pointer; transition: background 0.15s;
}
.sel-cancel-btn:hover { background: rgba(255,255,255,0.2); color: white; }
.sel-action-btn {
  display: flex; align-items: center; gap: 5px;
  padding: 6px 11px; border-radius: 8px; border: none;
  background: rgba(255,255,255,0.12); color: rgba(255,255,255,0.9);
  font-size: 12px; font-weight: 500; cursor: pointer; transition: background 0.15s;
}
.sel-action-btn:hover { background: rgba(255,255,255,0.22); }
.sel-divider { width: 1px; height: 18px; background: rgba(255,255,255,0.18); margin: 0 2px; flex-shrink: 0; }

/* ── 拖拽遮罩 ── */
.drop-overlay {
  position: absolute; inset: 0; z-index: 50;
  background: rgba(232,233,238,0.82);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  border-radius: inherit;
  corner-shape: inherit;   /* 跟随父级圆角形状（glass-card 是 squircle），否则与父级圆角不重合 → 双层圆角 */
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

/* ── 动画 ── */
.action-bar-enter-active, .action-bar-leave-active { transition: opacity 0.2s; }
.action-bar-enter-from, .action-bar-leave-to { opacity: 0; }

.drop-fade-enter-active, .drop-fade-leave-active { transition: opacity 0.18s; }
.drop-fade-enter-from, .drop-fade-leave-to { opacity: 0; }

.content-body { width: 100%; height: 100%; display: contents; }
</style>
