<template>
  <ProjectModalShell
    :show="!!project"
    :root-class="{ modal: true, 'stages-expanded': stagesExpanded, 'info-expanded': infoExpanded, 'pm-switching': pmSwitching }"
    @close="onModalClose"
  >
        <!-- 悬浮操作按钮：文件多选模式下让位给 .pm-selection-bar（同在右下角，多选栏内容多时会重叠，
             且两边都有删除按钮离太近容易误触），多选栏自己有取消/删除，先隐藏这组项目级按钮 -->
        <div v-if="!pmInSelectionMode" class="float-actions">
          <button class="save-float-btn" @click="closeProjectModal" title="保存并关闭">
            <PhCheck :size="14" weight="bold" />
          </button>
          <button class="archive-float-btn" @click="handleArchive" title="归档此项目（可逆，随时可在「已归档」里恢复）">
            <PhArchive :size="14" weight="bold" />
          </button>
          <button class="del-float-btn" @click="handleDelete" title="删除此项目">
            <PhTrash :size="14" weight="bold" />
          </button>
        </div>

        <!-- 左栏 -->
        <div class="modal-left panel-left">

          <!-- 标题保持在固定头部，避免随信息内容滚动 -->
          <div class="proj-header">
            <div class="header-main">
              <button class="status-ball" :class="'sb-' + localStatus" @click.stop="cycleStatus"
                :title="projectStore.kanbanColumns.find(c => c.key === localStatus)?.label ?? localStatus"></button>
              <input
                v-model="localName"
                class="header-name-input"
                placeholder="项目名称"
                @blur="saveName"
                v-enter="(e) => (e.target as HTMLElement).blur()"
                @keydown.esc="cancelName"
              />
            </div>
            <div class="header-progress-bar">
              <div class="header-progress-fill" :style="{ width: headerProgress + '%', background: localColor }"></div>
            </div>
          </div>

          <!-- 可滚动内容区 -->
          <div class="left-content scroll-surface scroll-surface--compact">
            <ProjectInfoPanel
              v-model:client="localClient"
              v-model:start-date="localStartDate"
              v-model:deadline="localDeadline"
              :color="localColor"
              :info-expanded="infoExpanded"
              :color-presets="colorPresets"
              @set-color="setColor"
            />

            <hr class="col-divider" />

            <ProjectStagesPanel
              v-model:stages="localStages"
              v-model:current-stage="localCurrentStage"
              :stage-color="localColor"
              :on-save-stages="saveStages"
              :on-save-todos="saveTodos"
              :on-set-stage="setStage"
            />

          </div><!-- /left-content -->
        </div>

        <ProjectFilesPanel :context="filePanelContext" />
  </ProjectModalShell>

  <!-- 右键菜单 -->
  <FileBrowserContextMenu :show="pmCtx.visible" :x="pmCtx.x" :y="pmCtx.y" @close="pmCtx.visible = false">
    <FileBrowserContextMenuContent
      :type="pmCtx.type"
      :mod-key="modKey"
      :folder-target-valid="true"
      :can-copy-folder="false"
      :delete-separator="true"
      :can-paste="pmCbStore.hasContent()"
      @action="handlePmCtxMenuAction"
    />
  </FileBrowserContextMenu>

  <!-- 文件详细信息弹窗 -->
  <FileInfoPopup
    :show="pmInfoPopup.show"
    :file="pmInfoPopup.file ?? undefined"
    :x="pmInfoPopup.x"
    :y="pmInfoPopup.y"
    @close="pmInfoPopup.show = false"
  />

  <!-- 上传同名冲突确认 -->
  <UploadConflictDialog ref="conflictDialogRef" />
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, toRef, onUnmounted, type PropType } from 'vue'
import { runtime } from '@/interaction/runtime'
import { useRuntimeAction } from '@/interaction/runtime/vue'
import {
  fileObjectId,
  browserSurfaceId as makeBrowserSurfaceId,
  folderSurfaceId,
} from '@/interaction/runtime/adapters/file/fileRuntimeAdapter'
import { useProjectStore } from '@/stores/projects'
import { PROJECT_COLOR_PRESETS, extractProjectAccent } from '@/utils/projectColors'
import { useFilesCacheStore, type FileMeta, type FolderMeta } from '@/stores/filesCache'
import type { Project, ProjectStage, ProjectTodo } from '@/types/project'
import { projectsApi } from '@/services/api'
import { thumbLoadedIds } from '@/composables/useThumbCache'
import { isImageExt as isPmImageExt, fileIconColor } from '@/utils/fileTypes'
import { useSorting } from '@/composables/useSorting'
import { fireHint } from '@/composables/useOnboarding'
import ProjectModalShell from '@/views/Projects/components/ProjectModalShell.vue'
import UploadConflictDialog, { type ConflictItem, type ConflictDecision } from '@/components/common/UploadConflictDialog.vue'
import { usePreviewStore, isPreviewable } from '@/stores/preview'
import {
  PhCheck, PhTrash, PhArchive,
} from '@phosphor-icons/vue'
import FileInfoPopup from '@/components/common/FileInfoPopup.vue'
import FileBrowserContextMenu from '@/components/common/file-browser/FileBrowserContextMenu.vue'
import FileBrowserContextMenuContent from '@/components/common/file-browser/FileBrowserContextMenuContent.vue'
import ProjectInfoPanel from '@/views/Projects/components/ProjectInfoPanel.vue'
import ProjectStagesPanel from '@/views/Projects/components/ProjectStagesPanel.vue'
import ProjectFilesPanel from '@/views/Projects/components/ProjectFilesPanel.vue'
import { useClipboardStore } from '@/stores/clipboard'
import { useLiveStore } from '@/stores/live'
import { usePreferencesStore } from '@/stores/preferences'
import { useFileSelection } from '@/composables/files/useFileSelection'
import { useProjectFileWorkspace } from '@/composables/files/useProjectFileWorkspace'
import { useFileActions } from '@/composables/files/useFileActions'
import { useProjectDraft } from '@/composables/projects/useProjectDraft'
import { useProjectStages } from '@/composables/projects/useProjectStages'
import { calculateHeaderProgress } from '@/composables/projects/useProjectProgress'
import { useProjectModalActions } from '@/composables/projects/useProjectModalActions'
import { useProjectFileMutations } from '@/composables/files/useProjectFileMutations'
import { useProjectFileUpload } from '@/composables/files/useProjectFileUpload'
import { useProjectFileBatchActions } from '@/composables/files/useProjectFileBatchActions'
import { useProjectFileContextActions } from '@/composables/files/useProjectFileContextActions'
import { useProjectFileDragMoves } from '@/composables/files/useProjectFileDragMoves'
import { useFileRuntimeMove } from '@/composables/files/useFileRuntimeMove'
import { useProjectFileKeyboard } from '@/composables/files/useProjectFileKeyboard'
import { useProjectFileSorting } from '@/composables/files/useProjectFileSorting'
import { useProjectFileRename } from '@/composables/files/useProjectFileRename'
import { useProjectFileProjectSync } from '@/composables/files/useProjectFileProjectSync'
import { useProjectModalLayout } from '@/composables/projects/useProjectModalLayout'

const props = defineProps({ project: { type: Object as PropType<Project | null>, default: null } })
const emit = defineEmits(['close'])
const sortMenuRef = ref<{ closeMenu: () => void } | null>(null)
function closeProjectModal() {
  sortMenuRef.value?.closeMenu()
  emit('close')
}
function onModalClose() { closeProjectModal() }

// e.message 兜底：console.error 里统一格式化未知类型的异常，跟 stores/projects.ts 的 errMsg 同一约定。
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const projectStore     = useProjectStore()
const fileActions      = useFileActions({
  scope: 'project',
  projectId: () => props.project?.id ?? null,
})
const fileCacheStore   = useFilesCacheStore()
const liveStore        = useLiveStore()
const prefsStore       = usePreferencesStore()
const {
  localName,
  localStages,
  localStartDate,
  localDeadline,
  localClient,
  localColor,
  localCurrentStage,
  localStatus,
  reset: resetProjectDraft,
} = useProjectDraft()
const projectStages = useProjectStages({
  stages: localStages,
  currentStage: localCurrentStage,
  status: localStatus,
})
const {
  saveName, cancelName, setColor, cycleStatus,
  saveStages, saveTodos, handleDelete, handleArchive,
} = useProjectModalActions({
  project: () => props.project,
  localName,
  localColor,
  localStatus,
  localStages,
  localCurrentStage,
  close: closeProjectModal,
})
const {
  fileViewMode, openFolders, folderStack, pmCanGoBack, pmCanGoForward,
  pmEnterFolder, pmNavigateTo, pmGoBack, pmGoForward, prunePmHistoryForFolder,
  resetPmNavigation, currentFolders, currentFiles, currentFolder, currentFolderFiles,
  pmFolderCount, totalFileCount,
} = useProjectFileWorkspace({
  projectId: () => props.project?.id ?? null,
  fileCacheStore,
})
const projectFileMutations = useProjectFileMutations({
  fileActions,
  fileCacheStore,
  projectId: () => props.project?.id ?? null,
  parentFolderId: () => folderStack.value.length ? folderStack.value[folderStack.value.length - 1].id : null,
  pruneFolderHistory: prunePmHistoryForFolder,
})
// tiny 已由 v-lazy-src 视口门控，不再全量预热

// ── 侧栏两模式：false=文件区宽（现状）；true=左右各 50%、信息区 2 列 ──
// 外框与内容并行切换：内容全程保持可见，只让列宽与信息区版面同步变化。
// 初值取自后端记忆（preferences）；若 preferences 晚于本组件加载完成，loaded 变 true 时再同步一次
const {
  stagesExpanded,
  infoExpanded,
  switching: pmSwitching,
  toggle: togglePmStages,
} = useProjectModalLayout({
  loaded: toRef(prefsStore, 'loaded'),
  pmStagesExpanded: toRef(prefsStore, 'pmStagesExpanded'),
  savePmStagesExpanded: prefsStore.savePmStagesExpanded,
})

// ── 项目文件区选择 ────────────────────────────────────────────────────────────
const {
  gridRef: pmGridRef,
  selectedFileIds: pmSelectedFileIds,
  selectedFolderIds: pmSelectedFolderIds,
  previewFileIds: pmPreviewFileIds,
  previewFolderIds: pmPreviewFolderIds,
  selectionRect: pmSelectionRect,
  inSelectionMode: pmInSelectionMode,
  selectionModeForced: pmSelectionModeForced,
  flatSelectableItems: pmFlatSelectableItems,
  onContainerMouseDown: onPmGridMouseDown,
  cancelDrag: _cancelPmBoxDrag,
  clearSelection: clearPmSelection,
  onContentClick: onPmContentClickImpl,
  toggleFolderSelect: toggleFolderSelectPm,
  toggleSelectionMode: togglePmSelectionMode,
  handleFileClick: pmHandleFileClick,
  onFileClick: onPmFileClick,
  onFolderClick: onPmFolderClick,
} = useFileSelection({
  getFolders: () => sortedCurrentFolders.value,
  getFiles: () => sortedCurrentFiles.value,
  openPreview: file => openPreview(file),
  isPreviewable,
  enterFolder: folder => pmEnterFolderWrapped(folder),
})

let suppressNextPmSelectionClick = false
function onPmContentClick() {
  if (suppressNextPmSelectionClick) {
    suppressNextPmSelectionClick = false
    return
  }
  onPmContentClickImpl()
}

// Tier 3：数据从全局 filesCache store 派生（currentFiles/currentFolders/pmFolderCount）。所有增删改
// 只需更新 store（updateFile/updateFolder/removeFile/removeFolder/addFile/addFolder），视图自动跟随——
// 不再各自 refetch、维护本地缓存、手工调计数徽标、或判断「刷哪一层」。删的都是当前层子项，视图自动
// 消失、导航路径不含它们，无需重置导航（仅清理指向已删文件夹的历史快照）。

// ── 拖动移动 ──────────────────────────────────────────────────────────────────
const { moveFolders: movePmFoldersInto, moveFiles: movePmFilesInto } = useProjectFileDragMoves({
  fileActions,
  fileCacheStore,
  projectId: () => props.project?.id ?? null,
})


// ── 排序 ──────────────────────────────────────────────────────────────────────
const { SORT_OPTIONS: PM_SORT_OPTIONS, sortKey: pmSortKey, sortDir: pmSortDir, onSortSelect: onPmSortSelect } = useSorting()

const {
  sortedFolders: sortedCurrentFolders,
  sortedFiles: sortedCurrentFiles,
} = useProjectFileSorting({
  folders: currentFolders,
  files: currentFiles,
  sortKey: pmSortKey,
  sortDir: pmSortDir,
})

// ── Runtime Vue API：项目文件区与文件库共用同一套对象/Surface/Target 接入 ──
// ProjectModal 是全局单例，文件对象 ID 本身全局唯一，因此使用稳定 scope，避免 project
// prop 切换时让静态 Surface 注册与项目文件 DOM 保持同一生命周期。
const RUNTIME_SCOPE = 'project-files'
const pmRuntimeBrowserSurfaceId = makeBrowserSurfaceId(RUNTIME_SCOPE)
const pmRuntimeBrowserGeneration = runtime.surfaces.register({
  id: pmRuntimeBrowserSurfaceId,
  type: 'file-browser',
  accepts: ['file-item', 'folder-item'],
  layout: 'grid',
  element: null,
})
const pmRuntimeBrowserRef = ref<HTMLElement | null>(null)
watch(pmRuntimeBrowserRef, (element, previous) => {
  const current = runtime.surfaces.get(pmRuntimeBrowserSurfaceId)
  if (current?.generation !== pmRuntimeBrowserGeneration) return
  if (element === null && current.element && current.element !== previous) return
  runtime.surfaces.setElement(pmRuntimeBrowserSurfaceId, element)
}, { flush: 'post' })

function bindPmGridEl(target: unknown) {
  const element = target as HTMLElement | null
  pmGridRef.value = element
  pmRuntimeBrowserRef.value = element
}
onUnmounted(() => {
  if (runtime.surfaces.get(pmRuntimeBrowserSurfaceId)?.generation === pmRuntimeBrowserGeneration) {
    runtime.surfaces.unregister(pmRuntimeBrowserSurfaceId, pmRuntimeBrowserGeneration)
  }
})

const { handleAction: handleRuntimeMoveAction } = useFileRuntimeMove({
  scope: RUNTIME_SCOPE,
  browserSurfaceId: makeBrowserSurfaceId(RUNTIME_SCOPE),
  resolveBreadcrumbTarget: idx => {
    if (idx === -1) {
      if (!folderStack.value.length) return null
      return { folderId: null, droppedOn: 'breadcrumb' }
    }
    const seg = folderStack.value[idx]
    return seg ? { folderId: seg.id, droppedOn: 'breadcrumb' } : null
  },
  moveFolders: movePmFoldersInto,
  moveFiles: movePmFilesInto,
  clearSelection: clearPmSelection,
})

useRuntimeAction(action => {
  if (action.type !== 'move' && action.type !== 'move-group') return
  const objectIds = action.type === 'move-group' ? action.objectIds : [action.objectId]
  if (!objectIds.some(id => id.startsWith(`${RUNTIME_SCOPE}:`))) return
  suppressNextPmSelectionClick = true
  void handleRuntimeMoveAction(objectIds, action.toSurfaceId)
})

// ── 目录导航：与文件库保持同一契约 ──────────────────────────────────────────────
// Runtime 继续负责真实拖拽 Object/Surface/Target；目录切换只保留“拖拽事务期间禁止销毁卡片”的
// 守卫，通过后直接改变当前目录状态。不要把目录导航重新接回 runLayoutMutation/Collection Presence，
// 否则上一目录的卡片会被保留成离场代理并在 file-content surface 外继续淡出。
function hasActivePmMove(): boolean {
  const root = pmGridRef.value
  if (!root) return false
  const cards = root.querySelectorAll<HTMLElement>('[data-layout-role="card"]')
  for (const card of cards) {
    const key = card.dataset.layoutKey
    if (key && runtime.isControlled(key)) return true
  }
  return false
}
function withPmDirectNav(mutate: () => void): void {
  if (hasActivePmMove()) return
  mutate()
}
function pmEnterFolderWrapped(folder: FolderMeta): void { withPmDirectNav(() => pmEnterFolder(folder)) }
function pmNavigateToWrapped(idx: number): void { withPmDirectNav(() => pmNavigateTo(idx)) }
function pmGoBackWrapped(): void { withPmDirectNav(() => pmGoBack()) }
function pmGoForwardWrapped(): void { withPmDirectNav(() => pmGoForward()) }

// collection / layout key 继续供当前目录内的真实 Runtime 拖拽与布局识别使用；它们不再参与目录 Presence。
const pmLayoutCollection = computed(() => `project-files:${props.project?.id ?? 'none'}`)
function pmFolderLayoutKey(folder: FolderMeta): string {
  return fileObjectId(RUNTIME_SCOPE, 'folder', folder.id)
}
function pmFileLayoutKey(file: FileMeta): string {
  return fileObjectId(RUNTIME_SCOPE, 'file', file.id)
}

// ── 文件夹 ────────────────────────────────────────────────────────────────────

const showNewFolder  = ref(false)
const newFolderName  = ref('')
const folderLoading  = ref(false)

async function createFolder() {
  const name = newFolderName.value.trim()
  if (!name || !props.project?.id) return
  folderLoading.value = true
  try {
    await projectFileMutations.createFolder(name)
    newFolderName.value = ''
    showNewFolder.value = false
  } catch (e) {
    console.error('[ProjectModal] 新建文件夹失败:', errMsg(e))
  } finally {
    folderLoading.value = false
  }
}

// ── 重命名 ────────────────────────────────────────────────────────────────────

const {
  renamingFileId, renameText, startRename, cancelRename, commitRename,
  renamingFolderId, folderRenameText, startRenameFolder, cancelFolderRename, commitFolderRename,
} = useProjectFileRename({
  renameFile: (id, name) => projectFileMutations.renameFile(id, name).catch(e => console.error('[ProjectModal] 重命名失败:', errMsg(e))),
  renameFolder: (id, name) => projectFileMutations.renameFolder(id, name).catch(e => console.error('[ProjectModal] 文件夹重命名失败:', errMsg(e))),
})

// ── 删除 ─────────────────────────────────────────────────────────────────────

async function deleteFile(file: FileMeta) {
  try {
    await projectFileMutations.deleteFile(file)
  } catch (e) {
    console.error('[ProjectModal] 删除失败:', errMsg(e))
  }
}

// ── 下载 ─────────────────────────────────────────────────────────────────────

function downloadFile(file: FileMeta) {
  return projectFileMutations.downloadFile(file)
}

// ── 预览 ──
const previewStore = usePreviewStore()
const openPreview = (f: FileMeta) => previewStore.open(f, sortedCurrentFiles.value)


// ── 文件类型辅助 ──────────────────────────────────────────────────────────────

// 文件类型助手（isImageExt→isPmImageExt / fileExtCategory / fileIconColor）与缩略图懒加载指令
// vLazySrc 已统一到 @/utils/fileTypes 和 @/composables/useLazyThumb，见顶部 import。
// 注：fileIconColor 改用共享版（pdf/doc 等单列颜色，不再统一灰）；isImageExt 含 svg（svg 现也显缩略图）。

// ── 文件夹操作 ────────────────────────────────────────────────────────────────

function downloadFolderZip(folder: FolderMeta) {
  return projectFileMutations.downloadFolder(folder)
}

async function deleteFolderCard(folder: FolderMeta) {
  try {
    await projectFileMutations.deleteFolder(folder)
  } catch (e) {
    console.error('[ProjectModal] 删除文件夹失败:', errMsg(e))
  }
}

// 外部（Agent/IM）修改日期时同步本地状态（project?.id 不变，但日期值变了）
const { initializing } = useProjectFileProjectSync({
  project: () => props.project,
  openFolders,
  folderStack,
  resetNavigation: resetPmNavigation,
  showNewFolder,
  resetDraft: resetProjectDraft,
  fileCacheStore,
})

// 外部（Agent/IM）修改日期时同步本地状态（project?.id 不变，但日期值变了）
watch(() => props.project?.startDate, (v) => { if (!initializing.value) localStartDate.value = v ?? '' })
watch(() => props.project?.deadline,  (v) => { if (!initializing.value) localDeadline.value  = v ?? '' })





watch(localClient, v => {
  if (initializing.value) return
  const id = props.project?.id
  if (!id) return
  projectStore.updateProjectDebounced(id, { client: v || null })
})

watch(localStartDate, v => {
  if (initializing.value) return
  const id = props.project?.id
  if (!id) return
  projectStore.updateProject(id, { startDate: v || null })
})

watch(localDeadline, v => {
  if (initializing.value) return
  const id = props.project?.id
  if (!id) return
  projectStore.updateProject(id, { deadline: v || null })
})

const headerProgress = computed(() => {
  return calculateHeaderProgress(localStages.value, localCurrentStage.value)
})

// 只在明确切换阶段时调用，拖动重排不触发

const accentColor = computed(() => extractProjectAccent(localColor.value || props.project?.color))

const colorPresets = [...PROJECT_COLOR_PRESETS]

function setStage(key: string, idx: number) {
  const transition = projectStages.transitionStage(key)
  if (!transition) return
  if (transition.oldIndex !== transition.newIndex) fireHint('stage_switch')
  if (props.project) projectStore.setStage(props.project.id, key, transition.progress)
}

const conflictDialogRef = ref<{ show: (list: ConflictItem[]) => Promise<Map<string, ConflictDecision>> } | null>(null)
const {
  uploadingItems,
  dragging,
  handleFileInput,
  handleFileDrop,
  isDragging: pmIsDragging,
  onDragEnter: onPmDragEnter,
  onDragLeave: onPmDragLeave,
  onDrop: onPmDrop,
} = useProjectFileUpload({
  projectId: () => props.project?.id ?? null,
  baseFolderId: () => currentFolder.value?.id ?? null,
  fileCacheStore,
  showConflicts: conflicts => conflictDialogRef.value?.show(conflicts)
    ?? Promise.resolve(new Map<string, ConflictDecision>()),
})

// ── 剪贴板 & 右键菜单（ProjectModal）──────────────────────────────────────────
const isMac = navigator.platform.toUpperCase().includes('MAC') || navigator.userAgent.includes('Mac')
const modKey = isMac ? '⌘' : 'Ctrl'
const pmCbStore = useClipboardStore()
const {
  downloading: pmDownloadingZip,
  downloadSelected: downloadSelectedPm,
  deleteSelected: deleteSelectedPm,
  cutSelected: pmSelCut,
  copySelected: pmSelCopy,
} = useProjectFileBatchActions({
  fileActions,
  fileCacheStore,
  clipboardStore: pmCbStore,
  selectedFileIds: pmSelectedFileIds,
  selectedFolderIds: pmSelectedFolderIds,
  getFiles: () => sortedCurrentFiles.value,
  getFolders: () => sortedCurrentFolders.value,
  getCurrentFolderName: () => currentFolder.value?.name ?? null,
  getProjectName: () => props.project?.name ?? '文件',
  clearSelection: clearPmSelection,
  pruneFolderHistory: prunePmHistoryForFolder,
})
const pmInfoPopup = ref<{ show: boolean; file: FileMeta | null; x: number; y: number }>({ show: false, file: null, x: 0, y: 0 })
const {
  state: pmCtx,
  openContext: openPmCtx,
  paste: pmCtxPaste,
  handleAction: handlePmCtxMenuAction,
} = useProjectFileContextActions({
  fileActions,
  fileCacheStore,
  clipboardStore: pmCbStore,
  selectedFileIds: pmSelectedFileIds,
  selectedFolderIds: pmSelectedFolderIds,
  getFiles: () => sortedCurrentFiles.value,
  getFolders: () => sortedCurrentFolders.value,
  getFolderStack: () => folderStack.value,
  getProjectId: () => props.project?.id ?? null,
  getProjectName: () => props.project?.name ?? '文件',
  clearSelection: clearPmSelection,
  startRenameFile: startRename,
  startRenameFolder,
  downloadFolder: downloadFolderZip,
  deleteFolder: deleteFolderCard,
  openInfo: (file, x, y) => { pmInfoPopup.value = { show: true, file, x, y } },
  showNewFolder,
  showConflicts: conflicts => conflictDialogRef.value?.show(conflicts)
    ?? Promise.resolve(new Map<string, ConflictDecision>()),
})

useProjectFileKeyboard({
  isProjectOpen: () => Boolean(props.project),
  selectedFileIds: pmSelectedFileIds,
  selectedFolderIds: pmSelectedFolderIds,
  clipboardStore: pmCbStore,
  paste: pmCtxPaste,
})

const filePanelContext = {
  stagesExpanded,
  togglePmStages,
  pmCanGoBack,
  pmGoBack: pmGoBackWrapped,
  pmCanGoForward,
  pmGoForward: pmGoForwardWrapped,
  pmNavigateTo: pmNavigateToWrapped,
  folderStack,
  pmCbStore,
  pmCtxPaste,
  pmInSelectionMode,
  togglePmSelectionMode,
  fileViewMode,
  showNewFolder,
  newFolderName,
  folderLoading,
  createFolder,
  PM_SORT_OPTIONS,
  pmSortKey,
  pmSortDir,
  onPmSortSelect,
  closeProjectModal,
  pmIsDragging,
  pmSelectionRect,
  pmGridRef,
  bindPmGridEl,
  onPmGridMouseDown,
  onPmContentClick,
  openPmCtx,
  onPmDragEnter,
  onPmDragLeave,
  onPmDrop,
  sortedCurrentFolders,
  pmFolderCount,
  accentColor,
  folderLayoutKey: pmFolderLayoutKey,
  fileLayoutKey: pmFileLayoutKey,
  layoutCollection: pmLayoutCollection,
  pmSelectedFolderIds,
  pmPreviewFolderIds,
  onPmFolderClick,
  renamingFolderId,
  commitFolderRename,
  startRenameFolder,
  downloadFolderZip,
  deleteFolderCard,
  folderRenameText,
  cancelFolderRename,
  sortedCurrentFiles,
  isPmImageExt,
  pmSelectedFileIds,
  pmPreviewFileIds,
  renamingFileId,
  startRename,
  commitRename,
  renameText,
  cancelRename,
  thumbLoadedIds,
  downloadFile,
  deleteFile,
  pmHandleFileClick,
  runtimeScope: RUNTIME_SCOPE,
  uploadingItems,
  dragging,
  handleFileDrop,
  handleFileInput,
  fileIconColor,
  pmDownloadingZip,
  downloadSelectedPm,
  pmSelCut,
  pmSelCopy,
  deleteSelectedPm,
  clearPmSelection,
}
</script>

<style scoped>
/* .drp-input 已由 DateSpanPicker.vue scoped 直接消费 --input-* token，不再需要 :deep 覆盖 */

.modal {
  display: flex;
  width: 100%; height: 100%;
  overflow: hidden;
}
.modal button { outline: none; }

/* ── 左栏 ── */
.modal-left {
  display: flex; flex-direction: column; overflow: hidden;
  width: 300px; flex-shrink: 0; will-change: width;
  /* 缓入保留，缓出尾巴拉长（P2=0.2,1）→ 到位是「沉降」而非「急停」，消除生硬停下。
     时长 0.36s 与 togglePmStages 的 LAYOUT_MS 联动，改一处两处一起改。 */
  transition: width 0.36s cubic-bezier(0.45, 0, 0.2, 1);
}
/* 列宽由 stages-expanded 驱动 */
.modal.stages-expanded .modal-left { width: 50%; }

/* 信息区版面由 info-expanded 驱动，与列宽同时切换。
   版面1：竖排，每行之间横向分割线（沿用 .col-divider）。
   版面2：2×2 网格，十字分割线——客户|周期、看板|颜色 竖线，上下两行之间横线（用 section 的 border 画）*/
.info-block { display: flex; flex-direction: column; }
.modal.info-expanded .info-block {
  display: grid; grid-template-columns: 1fr 1fr; gap: 0; align-items: stretch;
}
.modal.info-expanded .info-block > .col-divider { display: none; }
.modal.info-expanded .info-block > .section { padding: 11px 16px; position: relative; min-height: 56px; }
/* 3 区块：客户 | 周期 同一行，颜色独占整行 */
.modal.info-expanded .info-block > .section:nth-of-type(3) { grid-column: 1 / -1; }
/* 横线：客户/周期 与 颜色 之间，整条独立 */
.modal.info-expanded .info-block > .section:nth-of-type(1),
.modal.info-expanded .info-block > .section:nth-of-type(2) {
  border-bottom: 1px solid rgba(0,0,0,0.07);
}
/* 竖线：仅 客户|周期 一条独立短线——固定 28px、居中，与横线不相交 */
.modal.info-expanded .info-block > .section:nth-of-type(1)::after {
  content: ''; position: absolute; right: 0; top: 50%; transform: translateY(-50%);
  width: 1px; height: 28px; background: rgba(0,0,0,0.07);
}

/* 标题 */
.proj-header {
  height: 52px; box-sizing: border-box;
  display: flex; flex-direction: column; flex-shrink: 0;
  position: relative;
}
.proj-header::after {
  content: '';
  position: absolute; inset: 0;
  pointer-events: none;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.85);
}
.header-main {
  flex: 1; display: flex; align-items: center; gap: 8px;
  padding: 0 16px; min-width: 0;
}
/* 状态球：项目名前的状态指示（点击循环状态，替代看板列）*/
.status-ball {
  width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0;
  border: none; padding: 0; cursor: pointer; outline: none;
  transition: transform 0.15s, box-shadow 0.15s;
}
.status-ball:hover { transform: scale(1.2); }
.sb-pending { background: #d46b6b; box-shadow: 0 0 0 3px rgba(212,107,107,0.2); }
.sb-active  { background: #c9943a; box-shadow: 0 0 0 3px rgba(201,148,58,0.2); }
.sb-done    { background: #5a9e88; box-shadow: 0 0 0 3px rgba(90,158,136,0.2); }
/* 名称：默认像纯文本，悬停/聚焦才浮出编辑框（与定时任务卡 .title-input 同款样式+动画） */
.header-name-input {
  flex: 1; min-width: 0; box-sizing: border-box;
  font-size: 17px; font-weight: 700; color: var(--text-primary);
  font-family: var(--font-sans); line-height: 1.2; outline: none;
  padding: 7px 11px; margin: 0 -11px 0 0;
  border: 1px solid transparent; border-radius: 10px; corner-shape: squircle;
  background: transparent; caret-color: var(--color-primary);
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
}
.header-name-input::placeholder { color: var(--text-secondary); opacity: 0.45; font-weight: 700; }
.header-name-input:hover {
  border-color: rgba(123,127,178,0.35); background: rgba(255,255,255,0.75);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 0 0 3px rgba(123,127,178,0.08);
}
.header-progress-bar {
  height: 3px; background: rgba(0,0,0,0.07); flex-shrink: 0; position: relative;
}
.header-progress-fill { height: 100%; border-radius: 99px; transition: width 0.4s; }
.header-pct {
  position: absolute; right: 8px; bottom: 5px;
  font-size: 12px; font-weight: 700; line-height: 1;
}

/* 可滚动内容区 */
.left-content {
  flex: 1; overflow-y: auto; padding: 12px 16px;
  display: flex; flex-direction: column; gap: 0; min-height: 0;
  scrollbar-gutter: auto;
}

.section { display: flex; flex-direction: column; gap: 5px; padding: 8px 0; }
.section-label {
  font-size: 10px; font-weight: 600; color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: 0.07em;
  display: flex; align-items: center; gap: 6px; flex-shrink: 0;
}
.label-hint {
  font-size: 9.5px; font-weight: 500; opacity: 0.6;
  text-transform: none; letter-spacing: 0;
}
.col-divider { border: none; height: 1px; background: linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.07) 20%, rgba(0,0,0,0.07) 80%, transparent 100%); margin: 0; }

.field-input {
  width: 100%; padding: 8px 11px; box-sizing: border-box;
  border: 1px solid var(--input-border); border-radius: var(--control-radius);
  background: var(--input-bg); font-size: 13px;
  font-family: var(--font-sans); color: var(--input-fg);
  outline: none; transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
}
.field-input:hover { border-color: var(--input-border-hover); background: var(--input-bg-hover); box-shadow: var(--input-hover-shadow); }
.field-input:focus { border-color: var(--input-border-focus); background: var(--input-bg-focus); box-shadow: var(--input-focus-shadow); }

/* 状态 */
.status-group { display: flex; gap: 4px; flex-wrap: wrap; justify-content: center; }
.status-btn {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 9px; border-radius: 20px;
  border: 1.5px solid transparent; font-size: 12px; font-weight: 600;
  cursor: pointer; font-family: var(--font-sans);
  background: rgba(0,0,0,0.10); color: #5a5f78;
  transition: background 0.15s, color 0.15s, border-color 0.15s; outline: none;
}
.status-btn:hover { background: rgba(0,0,0,0.15); color: var(--text-primary); }
.opt-dot { width: 6px; height: 6px; border-radius: 50%; }
.status-btn.s-pending .opt-dot { background: #d46b6b; }
.status-btn.s-active  .opt-dot { background: #c9943a; }
.status-btn.s-done    .opt-dot { background: #5a9e88; }
.status-btn.s-pending.active .opt-dot { background: #d46b6b; }
.status-btn.s-active.active  .opt-dot { background: #c9943a; }
.status-btn.s-done.active .opt-dot { background: #5a9e88; }
.status-btn.s-pending.active { background: rgba(212,107,107,0.12); border-color: rgba(212,107,107,0.5); color: #9e3e3e; }
.status-btn.s-active.active  { background: rgba(201,148,58,0.12);  border-color: rgba(201,148,58,0.5);  color: #8a5f18; }
.status-btn.s-done.active    { background: rgba(90,158,136,0.12);  border-color: rgba(90,158,136,0.4);  color: #2e6e5a; }

/* 配色 */
.color-grid { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; }
.color-chip {
  width: 22px; height: 22px; border-radius: 6px;   /* 方形（圆角）色块 */
  border: 2px solid rgba(255,255,255,0.5);
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: border-color 0.15s; padding: 0; outline: none;
}
.color-chip:hover { border-color: rgba(255,255,255,0.9); }
.color-chip.active { border-color: #fff; box-shadow: 0 0 0 2px rgba(0,0,0,0.18); }

/* 阶段 */



/* 悬浮操作按钮 */
.float-actions {
  position: absolute; bottom: 14px; right: 14px; z-index: 10;
  display: flex; gap: 8px; align-items: center;
}
.save-float-btn {
  width: 36px; height: 36px; border-radius: 10px;
  background: rgba(90,158,136,0.1);
  border: 1px solid rgba(90,158,136,0.28);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; color: var(--color-success);
  box-shadow: 0 2px 10px rgba(90,158,136,0.12);
  transition: background 0.15s, box-shadow 0.15s;
}
.save-float-btn:hover {
  background: rgba(90,158,136,0.18);
  box-shadow: 0 4px 14px rgba(90,158,136,0.22);
}
.del-float-btn {
  width: 36px; height: 36px; border-radius: 10px;
  background: rgba(176,120,88,0.1);
  border: 1px solid rgba(176,120,88,0.25);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; color: var(--color-warning);
  box-shadow: 0 2px 10px rgba(176,120,88,0.15);
  transition: background 0.15s, box-shadow 0.15s;
}
.del-float-btn:hover {
  background: rgba(176,120,88,0.18);
  box-shadow: 0 4px 14px rgba(176,120,88,0.25);
}
.archive-float-btn {
  width: 36px; height: 36px; border-radius: 10px;
  background: rgba(123,127,178,0.1);
  border: 1px solid rgba(123,127,178,0.25);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; color: var(--color-primary, #7b7fb2);
  box-shadow: 0 2px 10px rgba(123,127,178,0.12);
  transition: background 0.15s, box-shadow 0.15s;
}
.archive-float-btn:hover {
  background: rgba(123,127,178,0.18);
  box-shadow: 0 4px 14px rgba(123,127,178,0.22);
}

/* 右栏文件面板样式已迁移至 ProjectFilesPanel.vue。 */
</style>
