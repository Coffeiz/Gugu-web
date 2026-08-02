<template>
  <BaseModal :show="!!project" width="1060px" height="780px" @close="onModalClose">
      <div class="modal" :class="{ 'stages-expanded': stagesExpanded, 'info-expanded': infoExpanded, 'pm-switching': pmSwitching }">
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
          <div class="left-content">
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
      </div>
  </BaseModal>

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
import { ref, reactive, computed, watch, nextTick, onMounted, onUnmounted, type PropType } from 'vue'
import { useProjectStore } from '@/stores/projects'
import { transitionProjectStage } from '@/utils/projectStages'
import { PROJECT_COLOR_PRESETS } from '@/utils/projectColors'
import { useFilesCacheStore, type FileMeta, type FolderMeta } from '@/stores/filesCache'
import type { Project, ProjectStage, ProjectTodo } from '@/types/project'
import { projectsApi, uploadWithProgress } from '@/services/api'
import { thumbLoadedIds, clearThumbCache } from '@/composables/useThumbCache'
import { vLazyThumb as vLazySrc } from '@/composables/useLazyThumb'
import { isImageExt as isPmImageExt, fileExtCategory, fileIconColor } from '@/utils/fileTypes'
import { useSorting } from '@/composables/useSorting'
import { useUploadQueue } from '@/composables/useUploadQueue'
import { readDroppedEntries, filesToItems } from '@/composables/useFileUpload'
import { useBoxSelection } from '@/composables/useBoxSelection'
import { useFileDragDrop } from '@/composables/useFileDragDrop'
import { fireHint } from '@/composables/useOnboarding'
import BaseModal from '@/components/common/BaseModal.vue'
import UploadConflictDialog, { type ConflictItem, type ConflictDecision } from '@/components/common/UploadConflictDialog.vue'
import type { UploadItem } from '@/composables/useFileUpload'
import { usePreviewStore, isPreviewable } from '@/stores/preview'
import {
  PhFolder, PhArrowLeft, PhArrowRight, PhCaretLeft, PhCaretRight, PhCaretDown, PhSquaresFour, PhList,
  PhCheckSquare, PhFolderPlus, PhPencilSimple,
  PhDownloadSimple, PhX, PhCheck,
  PhWarningCircle, PhTrash, PhArchive,
} from '@phosphor-icons/vue'
import SortMenu from '@/components/common/SortMenu.vue'
import FileInfoPopup from '@/components/common/FileInfoPopup.vue'
import FileSelectionToolbar from '@/components/common/FileSelectionToolbar.vue'
import FilePasteButton from '@/components/common/FilePasteButton.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import FileCard from '@/components/common/FileCard.vue'
import FolderCard from '@/components/common/FolderCard.vue'
import FileUploadGhostCard from '@/components/common/FileUploadGhostCard.vue'
import FileUploadButton from '@/components/common/FileUploadButton.vue'
import FileBrowserGrid from '@/components/common/FileBrowserGrid.vue'
import FileBrowserBreadcrumb from '@/components/common/FileBrowserBreadcrumb.vue'
import FileBrowserContextMenu from '@/components/common/FileBrowserContextMenu.vue'
import FileBrowserContextMenuContent from '@/components/common/FileBrowserContextMenuContent.vue'
import FileBrowserList from '@/components/common/FileBrowserList.vue'
import ProjectInfoPanel from '@/views/Projects/components/ProjectInfoPanel.vue'
import ProjectStagesPanel from '@/views/Projects/components/ProjectStagesPanel.vue'
import ProjectFilesPanel from '@/views/Projects/components/ProjectFilesPanel.vue'
import { useClipboardStore } from '@/stores/clipboard'
import { useLiveStore } from '@/stores/live'
import { usePreferencesStore } from '@/stores/preferences'
import { parseFolderId } from '@/utils/folderKeys'
import { optimisticMutation } from '@/utils/optimisticMutation'
import { useFileSelection } from '@/composables/files/useFileSelection'
import { projectFileDirectory } from '@/composables/files/useFileProjection'
import { useProjectFileWorkspace } from '@/composables/files/useProjectFileWorkspace'
import { useFileActions } from '@/composables/files/useFileActions'
import { useFileContextMenu } from '@/composables/files/useFileContextMenu'
import { executeUploadLifecycle, prepareUploadBatch } from '@/composables/files/useFileUploadController'
import { useProjectDraft } from '@/composables/projects/useProjectDraft'

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
const {
  fileViewMode, openFolders, folderStack, pmCanGoBack, pmCanGoForward,
  pmEnterFolder, pmNavigateTo, pmGoBack, pmGoForward, prunePmHistoryForFolder,
  resetPmNavigation, currentFolders, currentFiles, currentFolder, currentFolderFiles,
  pmFolderCount, totalFileCount,
} = useProjectFileWorkspace({
  projectId: () => props.project?.id ?? null,
  fileCacheStore,
})
// tiny 已由 v-lazy-src 视口门控，不再全量预热

// ── 侧栏两模式：false=文件区宽（现状）；true=左右各 50%、信息区 2 列 ──
// 外框与内容并行切换：内容全程保持可见，只让列宽与信息区版面同步变化。
// 初值取自后端记忆（preferences）；若 preferences 晚于本组件加载完成，loaded 变 true 时再同步一次
const stagesExpanded = ref(prefsStore.pmStagesExpanded)   // 列宽/版面预设
const infoExpanded = ref(prefsStore.pmStagesExpanded)     // 信息区 1列/2列版面预设
const pmSwitching = ref(false)      // 布局切换锁（同时关闭嵌套 backdrop-filter）
watch(() => prefsStore.loaded, (v) => {
  if (v) { stagesExpanded.value = prefsStore.pmStagesExpanded; infoExpanded.value = prefsStore.pmStagesExpanded }
})
function togglePmStages() {
  if (pmSwitching.value) return
  const LAYOUT_MS = 360   // 与 .modal-left 的 width 过渡时长一致（0.36s）；改一处两处一起改
  pmSwitching.value = true
  // 留一帧提交当前布局，再启动列宽与信息区版面变化，内容全程不淡隐。
  requestAnimationFrame(() => {
    stagesExpanded.value = !stagesExpanded.value
    infoExpanded.value = stagesExpanded.value
    prefsStore.savePmStagesExpanded(stagesExpanded.value)
    setTimeout(() => { pmSwitching.value = false }, LAYOUT_MS)
  })
}

// ── 框选 ──────────────────────────────────────────────────────────────────────
const pmGridRef = ref(null)
const pmLastAnchorIndex = ref(-1)

const {
  selectedFileIds: pmSelectedFileIds,
  selectedFolderIds: pmSelectedFolderIds,
  previewFileIds: pmPreviewFileIds,
  previewFolderIds: pmPreviewFolderIds,
  boxStart: pmBoxStart,
  selectionRect: pmSelectionRect,
  onContainerMouseDown: onPmGridMouseDown,
  cancelDrag: _cancelPmBoxDrag,
  clearSelection: _clearPmSelBase,
} = useBoxSelection(pmGridRef, {
  fileAttr: 'data-pm-file-id',
  folderAttr: 'data-pm-folder-id',
  excludeSelector: 'button, input, .folder-card, .fc-card, label',
  parseFolderId: Number,
  onBoxSelect: ({ fileIds, folderIds }) => {
    pmSelectedFileIds.value   = fileIds
    pmSelectedFolderIds.value = folderIds
    if (fileIds.size + folderIds.size > 0) pmSelectionModeForced.value = true
  },
})

const pmSelectionModeForced = ref(false)
const pmDownloadingZip      = ref(false)
const pmFileSelection = useFileSelection({ fileIds: pmSelectedFileIds, folderIds: pmSelectedFolderIds })
const pmInSelectionMode = computed(() =>
  pmSelectionModeForced.value || pmSelectedFileIds.value.size > 0 || pmSelectedFolderIds.value.size > 0)

const pmFlatSelectableItems = computed(() => [
  ...sortedCurrentFolders.value.map(f => ({ type: 'folder' as const, id: f.id })),
  ...sortedCurrentFiles.value.map(f => ({ type: 'file' as const, id: f.id })),
])

function _pmShiftSelect(type: 'folder' | 'file', id: number) {
  const flat = pmFlatSelectableItems.value
  const idx = flat.findIndex(i => i.type === type && i.id === id)
  if (idx < 0) return false
  return pmFileSelection.selectRangeIn(flat, pmLastAnchorIndex.value, idx)
}

function clearPmSelection() {
  pmFileSelection.clearSelection()
  _clearPmSelBase()
  pmSelectionModeForced.value = false
  pmLastAnchorIndex.value     = -1
}

function onPmContentClick() {
  if (pmInSelectionMode.value) clearPmSelection()
}

function toggleFolderSelectPm(folder: FolderMeta) { pmFileSelection.toggleFolder(folder.id) }

function togglePmSelectionMode() {
  if (pmInSelectionMode.value) clearPmSelection()
  else pmSelectionModeForced.value = true
}
function pmHandleFileClick(file: FileMeta, e: MouseEvent) {
  if (e.shiftKey || e.ctrlKey || e.metaKey || pmInSelectionMode.value) {
    onPmFileClick(file, e)
  } else if (isPreviewable(file.ext)) {
    openPreview(file)
  } else {
    onPmFileClick(file, e)
  }
}

function onPmFileClick(file: FileMeta, e: MouseEvent) {
  if (e.shiftKey) {
    if (!_pmShiftSelect('file', file.id)) {
      pmSelectedFileIds.value = new Set([file.id])
      pmLastAnchorIndex.value = pmFlatSelectableItems.value.findIndex(i => i.type === 'file' && i.id === file.id)
    }
    return
  }
  if (e.ctrlKey || e.metaKey || pmInSelectionMode.value) {
    // 选中模式或 Ctrl/Cmd：toggle
    pmFileSelection.toggleFile(file.id)
    pmLastAnchorIndex.value = pmFlatSelectableItems.value.findIndex(i => i.type === 'file' && i.id === file.id)
    return
  } else {
    pmFileSelection.toggleExclusiveFile(file.id)
  }
  pmLastAnchorIndex.value = pmFlatSelectableItems.value.findIndex(i => i.type === 'file' && i.id === file.id)
}

function onPmFolderClick(folder: FolderMeta, e: MouseEvent) {
  if (e.shiftKey) {
    if (!_pmShiftSelect('folder', folder.id)) {
      pmSelectedFolderIds.value = new Set([folder.id])
      pmLastAnchorIndex.value = pmFlatSelectableItems.value.findIndex(i => i.type === 'folder' && i.id === folder.id)
    }
    return
  }
  if (e.ctrlKey || e.metaKey) {
    pmFileSelection.toggleFolder(folder.id)
    pmLastAnchorIndex.value = pmFlatSelectableItems.value.findIndex(i => i.type === 'folder' && i.id === folder.id)
    return
  }
  if (pmInSelectionMode.value) {
    toggleFolderSelectPm(folder)
    return
  }
  pmEnterFolder(folder)
}

async function downloadSelectedPm() {
  if (pmDownloadingZip.value) return
  const ids = [...pmSelectedFileIds.value]
  const folderIds = [...pmSelectedFolderIds.value]
  if (!ids.length && !folderIds.length) return

  pmDownloadingZip.value = true
  try {
    // 单个文件 → 直接下载
    if (ids.length === 1 && folderIds.length === 0) {
      const f = sortedCurrentFiles.value.find(f => f.id === ids[0])
      if (f) await fileActions.downloadFile(f)
      return
    }
    // 单个文件夹 → 以文件夹名打包
    if (folderIds.length === 1 && ids.length === 0) {
      const folder = sortedCurrentFolders.value.find(f => f.id === folderIds[0])
      if (folder) await fileActions.downloadFolder(folder)
      return
    }
    // 多选 → 以当前目录名打包
    const dirName = currentFolder.value?.name ?? props.project?.name ?? '文件'
    await fileActions.batchDownload(ids, folderIds, `${dirName}.zip`)
  } catch (e) {
    console.error('[ProjectModal] 批量下载失败:', errMsg(e))
  } finally {
    pmDownloadingZip.value = false
  }
}

// Tier 3：数据从全局 filesCache store 派生（currentFiles/currentFolders/pmFolderCount）。所有增删改
// 只需更新 store（updateFile/updateFolder/removeFile/removeFolder/addFile/addFolder），视图自动跟随——
// 不再各自 refetch、维护本地缓存、手工调计数徽标、或判断「刷哪一层」。删的都是当前层子项，视图自动
// 消失、导航路径不含它们，无需重置导航（仅清理指向已删文件夹的历史快照）。

async function deleteSelectedPm() {
  const visibleFileIds = new Set(sortedCurrentFiles.value.map(file => file.id))
  const visibleFolderIds = new Set(sortedCurrentFolders.value.map(folder => folder.id))
  const fids = [...pmSelectedFileIds.value].filter(id => visibleFileIds.has(id))
  const dids = [...pmSelectedFolderIds.value].filter(id => visibleFolderIds.has(id))
  if (!fids.length && !dids.length) return
  clearPmSelection()
  try {
    await Promise.all([
      ...fids.map(id => fileActions.deleteFile(id)),
      ...dids.map(id => fileActions.deleteFolder(id)),
    ])
    fileCacheStore.removeFiles(fids)
    dids.forEach(id => { fileCacheStore.removeFolder(id); prunePmHistoryForFolder([id]) })   // removeFolder 级联删子文件夹及其文件
    await fileCacheStore.refresh()
  } catch (err) { console.error('[ProjectModal] 批量删除失败:', errMsg(err)) }
}

// ── 拖动移动 ──────────────────────────────────────────────────────────────────
// pointer 模式，编排逻辑跟 Files/index.vue 共用同一份 useFileDragDrop——ProjectModal 特有规则：
// 文件夹卡片/行选择器、面包屑可接收文件与文件夹。落地更新 store 即可（视图自动派生）。
// 参数类型跟随 useFileDragDrop 的 FileDragDropConfig.moveFolders/moveFiles（Id = number | string），
// 实际项目场景下 id 永远是 number，但函数类型赋值是逆变检查，形参必须宽于（或等于）Id 才能结构兼容。
// 跟 Files/index.vue 的 moveFoldersInto/moveFilesInto 一样改用 optimisticMutation：之前是
// 先 await 接口、成功了才改缓存——网络稍慢或响应丢失时，拖拽落地后视图不会跟着变，卡片停在
// 原地，只有手动刷新页面重新拉取才会「消失」到目标层（2026-07-17 devserver 隔离验收环境
// 复现，不稳定必现，符合等接口的时序特征）。改成先乐观改缓存（拖拽落地立刻生效），接口在
// 后台跑，失败再回滚。
async function movePmFoldersInto(folderIds: (number | string)[], targetFolderId: number | string | null) {
  const nTarget = targetFolderId == null ? null : Number(targetFolderId)
  const nFolderIds = folderIds.map(Number)
  const projectId = props.project?.id ?? null
  const backups = nFolderIds.map(id => fileCacheStore.getFolder(id)).filter((f): f is FolderMeta => f != null)
  let results: FolderMeta[] = []
  await optimisticMutation({
    apply: () => nFolderIds.forEach(id => fileCacheStore.updateFolder(id, { parentId: nTarget, projectId })),
    afterMutate: () => {},
    // version 在 apply() 之后、work() 之前读——此时缓存里的 version 仍是服务端当前值；对不上
    // （并发改动）后端给 409，走 rollback。
    work: () => Promise.all(nFolderIds.map(id =>
      fileActions.moveFolder(id, nTarget, fileCacheStore.getFolder(id)?.version ?? 1, projectId))).then(r => { results = r }),
    rollback: () => backups.forEach(b => fileCacheStore.updateFolder(b.id, { parentId: b.parentId, projectId: b.projectId })),
    onCommit: () => results.forEach(f => fileCacheStore.updateFolder(f.id, { version: f.version })),
    onError: err => console.error('[ProjectModal] 移动文件夹失败:', errMsg(err)),
  })
  // 不再重置导航——store 单源，移走的文件夹自动从当前视图消失，用户停在原地即可（老代码重置到根是
  // 全量重拉的副作用，非有意行为）。
}
async function movePmFilesInto(fileIds: (number | string)[], targetFolderId: number | string | null, { droppedOn }: { droppedOn: 'folder' | 'breadcrumb' }) {
  // 必须显式带上 projectId：后端 update_file 未传 project_id 时保留原值，而项目文件夹内文件的
  // project_id 可能为 null（只靠 folder_id 关联）；拖到根不带 projectId 会落到个人库根、项目根查不到。
  void droppedOn
  const projectId = props.project?.id ?? null
  const folderId = targetFolderId == null ? null : Number(targetFolderId)
  const nFileIds = fileIds.map(Number)
  const backups = nFileIds.map(id => fileCacheStore.getFile(id)).filter((f): f is FileMeta => f != null)
  await optimisticMutation({
    apply: () => nFileIds.forEach(id => fileCacheStore.updateFile(id, { folderId, projectId })),
    afterMutate: () => {},
    work: () => Promise.all(nFileIds.map(id => fileActions.moveFile(id, folderId, projectId))),
    rollback: () => backups.forEach(f => fileCacheStore.updateFile(f.id, { folderId: f.folderId, projectId: f.projectId })),
    onError: err => console.error('[ProjectModal] 移动失败:', errMsg(err)),
  })
  // 视图/计数都从 store 现算，移走的文件自动消失、目标层自动出现，无需刷新或重置导航（停在原地）。
}

const pmDragCounter = ref(0)
const pmIsDragging = computed(() => pmDragCounter.value > 0)
const dragging = ref(false)
const {
  draggingFileIds: pmDraggingFileIds, draggingFolderIds: pmDraggingFolderIds,
  dragOverFolderId: pmDragOverFolderId, bcDragOverIdx: pmBcDragOverIdx,
  onFolderPointerDown: _onPmFolderPointerDown, onFilePointerDown: _onPmFilePointerDown,
} = useFileDragDrop({
  fileDataAttr: 'data-pm-file-id',
  folderDataAttr: 'data-pm-folder-id',
  folderSelector: '.folder-card, .folder-list-row',
  bcSelector: '.bc-seg',
  resolveBcTarget(idx) {
    // 面包屑各段（项目根 idx=-1 / 各祖先文件夹）都接收文件与文件夹——把子文件夹拖到「项目文件」根
    // 或某个祖先层。跟 Files 页面包屑一致；移动文件夹到根/祖先在 store 下是干净的 parent 改父。
    if (idx === -1) return { targetFolderId: null, acceptsFiles: true, acceptsFolders: true }
    const seg = folderStack.value[idx]
    return seg ? { targetFolderId: seg.id, acceptsFiles: true, acceptsFolders: true } : null
  },
  cancelBoxDrag: () => _cancelPmBoxDrag(),
  clearSelection: clearPmSelection,
  moveFolders: movePmFoldersInto,
  moveFiles: movePmFilesInto,
})

function onPmFolderPointerDown(folder: FolderMeta, e: PointerEvent) {
  _onPmFolderPointerDown(e, {
    itemId: folder.id,
    isSelected: pmSelectedFolderIds.value.has(folder.id),
    selectedFileIds: pmSelectedFileIds.value,
    selectedFolderIds: pmSelectedFolderIds.value,
    extraOpts: stagesExpanded.value ? { cloneClass: 'pm-clone-expanded' } : {},
  })
}
function onPmFilePointerDown(file: FileMeta, e: PointerEvent) {
  _onPmFilePointerDown(e, {
    itemId: file.id,
    isSelected: pmSelectedFileIds.value.has(file.id),
    selectedFileIds: pmSelectedFileIds.value,
    selectedFolderIds: pmSelectedFolderIds.value,
    extraOpts: stagesExpanded.value ? { cloneClass: 'pm-clone-expanded' } : {},
  })
}

// ── 排序 ──────────────────────────────────────────────────────────────────────
const { SORT_OPTIONS: PM_SORT_OPTIONS, sortKey: pmSortKey, sortDir: pmSortDir, onSortSelect: onPmSortSelect } = useSorting()

const sortedCurrentDirectory = computed(() => projectFileDirectory(
  currentFolders.value,
  currentFiles.value,
  pmSortKey.value,
  pmSortDir.value,
  {
    folderSorters: { name: folder => folder.name, type: folder => folder.name, id: folder => folder.id },
    fileSorters: {
      name: file => file.displayName,
      type: file => `${fileExtCategory(file.ext)}:${file.ext ?? ''}`,
      stage: file => file.stageName ?? '',
      createdAt: file => file.createdAt,
      size: file => file.sizeBytes ?? 0,
      id: file => file.id,
    },
  },
))
const sortedCurrentFolders = computed(() => sortedCurrentDirectory.value.folders)
const sortedCurrentFiles = computed(() => sortedCurrentDirectory.value.files)

// ── 文件夹 ────────────────────────────────────────────────────────────────────

const showNewFolder  = ref(false)
const newFolderName  = ref('')
const folderLoading  = ref(false)
const folderInputRef = ref<HTMLInputElement | null>(null)

watch(showNewFolder, v => { if (v) nextTick(() => folderInputRef.value?.focus()) })

async function createFolder() {
  const name = newFolderName.value.trim()
  if (!name || !props.project?.id) return
  const stack = folderStack.value
  const parentId = stack.length ? stack[stack.length - 1].id : null
  folderLoading.value = true
  try {
    const created = await fileActions.createFolder(props.project.id, name, parentId)
    fileCacheStore.addFolder(created)   // 视图（currentFolders）自动出现该文件夹
    newFolderName.value = ''
    showNewFolder.value = false
  } catch (e) {
    console.error('[ProjectModal] 新建文件夹失败:', errMsg(e))
  } finally {
    folderLoading.value = false
  }
}

// ── 重命名 ────────────────────────────────────────────────────────────────────

const renamingFileId = ref<number | null>(null)
const renameText     = ref('')

function startRename(file: FileMeta) {
  renamingFileId.value = file.id
  renameText.value     = file.displayName
  nextTick(() => {
    const el = document.querySelector<HTMLInputElement>('.rename-input-inline')
    el?.focus(); el?.select()
  })
}
function cancelRename() {
  renamingFileId.value = null
  renameText.value     = ''
}
function commitRename() {
  const id   = renamingFileId.value
  const name = renameText.value.trim()
  renamingFileId.value = null
  if (!id || !name) return
  // 乐观更新：先改本地缓存立刻生效，请求在后台跑，失败再回滚——跟 Files/index.vue 的
  // commitRename 保持一致，改之前这里是等请求回来才更新，输完名字要等一下才看到生效。
  const oldName = fileCacheStore.getFile(id)?.displayName
  fileCacheStore.updateFile(id, { displayName: name })
  fileActions.renameFile(id, name).catch(e => {
    if (oldName != null) fileCacheStore.updateFile(id, { displayName: oldName })
    console.error('[ProjectModal] 重命名失败:', errMsg(e))
  })
}

// ── 删除 ─────────────────────────────────────────────────────────────────────

async function deleteFile(file: FileMeta) {
  try {
    await fileActions.deleteFile(file.id)
    fileCacheStore.removeFile(file.id)
  } catch (e) {
    console.error('[ProjectModal] 删除失败:', errMsg(e))
  }
}

// ── 下载 ─────────────────────────────────────────────────────────────────────

function downloadFile(file: FileMeta) {
  return fileActions.downloadFile(file)
}

// ── 预览 ──
const previewStore = usePreviewStore()
const openPreview = (f: FileMeta) => previewStore.open(f, sortedCurrentFiles.value)

// ── 文件类型辅助 ──────────────────────────────────────────────────────────────

// 文件类型助手（isImageExt→isPmImageExt / fileExtCategory / fileIconColor）与缩略图懒加载指令
// vLazySrc 已统一到 @/utils/fileTypes 和 @/composables/useLazyThumb，见顶部 import。
// 注：fileIconColor 改用共享版（pdf/doc 等单列颜色，不再统一灰）；isImageExt 含 svg（svg 现也显缩略图）。

// ── 文件夹操作 ────────────────────────────────────────────────────────────────

const renamingFolderId  = ref<number | null>(null)
const folderRenameText  = ref('')

function startRenameFolder(folder: FolderMeta) {
  renamingFolderId.value = folder.id
  folderRenameText.value = folder.name
  nextTick(() => {
    const el = document.querySelector<HTMLInputElement>('.rename-input-inline')
    el?.focus(); el?.select()
  })
}
function cancelFolderRename() {
  renamingFolderId.value = null
  folderRenameText.value = ''
}
function commitFolderRename() {
  const id   = renamingFolderId.value
  const name = folderRenameText.value.trim()
  renamingFolderId.value = null
  if (!id || !name) return
  // 乐观更新，跟 commitRename 同样的理由；版本冲突（409）时用 fileCacheStore.refresh()
  // 把最新状态和 version 拉回来，避免本地卡在过期版本号上，后续再改必冲突。
  const oldFolder = fileCacheStore.getFolder(id)
  const oldName   = oldFolder?.name
  const version   = oldFolder?.version ?? 1
  fileCacheStore.updateFolder(id, { name })
  fileActions.renameFolder(id, name, version).then(updated => {
    fileCacheStore.updateFolder(id, { version: updated.version })
  }).catch(e => {
    if (oldName != null) fileCacheStore.updateFolder(id, { name: oldName })
    fileCacheStore.refresh()
    console.error('[ProjectModal] 文件夹重命名失败:', errMsg(e))
  })
}

function downloadFolderZip(folder: FolderMeta) {
  return fileActions.downloadFolder(folder)
}

async function deleteFolderCard(folder: FolderMeta) {
  prunePmHistoryForFolder([folder.id])
  try {
    await fileActions.deleteFolder(folder.id)
    fileCacheStore.removeFolder(folder.id)   // 级联删该文件夹的子文件夹及其文件；视图自动更新
  } catch (e) {
    console.error('[ProjectModal] 删除文件夹失败:', errMsg(e))
  }
}

let initializing = false


// 外部（Agent/IM）修改日期时同步本地状态（project?.id 不变，但日期值变了）
watch(() => props.project?.startDate, (v) => { if (!initializing) localStartDate.value = v ?? '' })
watch(() => props.project?.deadline,  (v) => { if (!initializing) localDeadline.value  = v ?? '' })

watch(() => props.project?.id, async (id) => {
  initializing = true
  resetProjectDraft(props.project)
  openFolders.value    = new Set()
  folderStack.value    = []
  resetPmNavigation()
  showNewFolder.value  = false
  await nextTick()
  initializing = false
  if (!id) return
  // Tier 3：文件/文件夹从全局 filesCache store 派生（currentFiles/currentFolders），这里只确保 store
  // 已加载（store 一次性拉全量、含本项目数据）。store 自带 SSE + visibilitychange，咕咕/IM 或别处
  // 改了文件会自动流到 currentFiles/currentFolders，无需本组件再自持缓存或单独订阅 rev.files 重拉。
  if (!fileCacheStore.loaded && !fileCacheStore.loading) fileCacheStore.load()
}, { immediate: true })





watch(localClient, v => {
  if (initializing) return
  const id = props.project?.id
  if (!id) return
  projectStore.updateProjectDebounced(id, { client: v || null })
})

watch(localStartDate, v => {
  if (initializing) return
  const id = props.project?.id
  if (!id) return
  projectStore.updateProject(id, { startDate: v || null })
})

watch(localDeadline, v => {
  if (initializing) return
  const id = props.project?.id
  if (!id) return
  projectStore.updateProject(id, { deadline: v || null })
})

const currentStageIndex = computed(() =>
  localStages.value.findIndex(s => s.key === localCurrentStage.value))
// 当前阶段所在位置索引（位置固定，拖动重排不改变）

// 被锁定的阶段下标集合：前面阶段 todo 全部手动完成时，该阶段及之前不可退回


function calcProgress(stages: ProjectStage[], currentStageKey: string) {
  if (!stages.length) return 0
  const idx = stages.findIndex(s => s.key === currentStageKey)
  if (idx < 0) return 0
  const w = 100 / stages.length
  const todos = stages[idx].todos ?? []
  const within = todos.length > 0 ? (todos.filter(t => t.done).length / todos.length) * w : w
  return Math.round(idx * w + within)
}

// 顶部进度条：按「总完成度」= 所有阶段待办里已完成 / 总数（不按阶段位置）；
// 没有任何待办时退回按当前阶段位置。仅用于头部条显示，持久化的 progress 不动。
const headerProgress = computed(() => {
  const stages = localStages.value
  if (!stages.length) return 0
  let done = 0, total = 0
  for (const s of stages) {
    const todos = s.todos ?? []
    done += todos.filter(t => t.done).length
    total += todos.length
  }
  if (total > 0) return Math.round(done / total * 100)
  return calcProgress(stages, localCurrentStage.value)
})

// 只在明确切换阶段时调用，拖动重排不触发

function extractAccent(colorStr: string | undefined) {
  const m = colorStr?.match(/#[0-9a-fA-F]{6}/)
  return m ? m[0] : '#7b7fb2'
}
const accentColor   = computed(() => extractAccent(localColor.value || props.project?.color))
const accentColorBg = computed(() => {
  const c = accentColor.value
  return c ? c.replace(/^#/, '') .match(/.{2}/g)
    ?.map(x => parseInt(x, 16))
    .reduce((_: string, __: number, ___: number, a: number[]) => `rgba(${a[0]},${a[1]},${a[2]},0.12)`, 'rgba(123,127,178,0.12)')
    ?? 'rgba(123,127,178,0.12)' : 'rgba(123,127,178,0.12)'
})

const colorPresets = [...PROJECT_COLOR_PRESETS]

function saveName() {
  if (!props.project) return
  const n = localName.value.trim()
  if (!n) {
    localName.value = props.project.name
  } else if (n !== props.project.name) {
    localName.value = n
    projectStore.updateProject(props.project.id, { name: n })
  }
}
function cancelName() {
  if (props.project) localName.value = props.project.name   // esc 还原，blur 时 saveName 视为无改动
}

function setColor(c: string) {
  localColor.value = c
  if (props.project) projectStore.updateProject(props.project.id, { color: c })
}

// 状态球：点一下循环 待开始 → 进行中 → 已完成（替代原看板列）
function cycleStatus() {
  const cols = projectStore.kanbanColumns
  const idx = cols.findIndex(c => c.key === localStatus.value)
  const next = cols[(idx + 1) % cols.length].key
  localStatus.value = next
  if (props.project?.id) projectStore.moveProject(props.project.id, next)
}

function setStage(key: string, idx: number) {
  const oldIdx = localStages.value.findIndex(s => s.key === localCurrentStage.value)
  const newIdx = idx

  // 往回跳时：若路径上有阶段的 todo 全部手动完成（非 autoCompleted），禁止退回
  if (newIdx < oldIdx) {
    const stages = localStages.value
    for (let i = newIdx; i < oldIdx; i++) {
      const todos = stages[i].todos ?? []
      if (todos.length > 0 && todos.every(t => t.done && !t.autoCompleted)) return
    }
  }

  const newProgress = calcProgress(localStages.value, key)
  const transition = transitionProjectStage({
    stages: localStages.value,
    currentStage: localCurrentStage.value || null,
    progress: newProgress,
    status: localStatus.value as Project['status'],
  }, key, newProgress)
  localStages.value = transition.stages
  localCurrentStage.value = transition.currentStage ?? ''
  localStatus.value = transition.status
  if (oldIdx !== newIdx) fireHint('stage_switch')   // 新手引导：第一次切换阶段
  if (props.project) projectStore.setStage(props.project.id, key, newProgress)
}

async function handleDelete() {
  if (!props.project) return
  const id = props.project.id
  // 项目里有文件/文件夹时：它们会随项目一并删除，先弹浏览器确认；没有则直接删
  const fileCnt   = fileCacheStore.loaded ? fileCacheStore.allFiles.filter(f => f.projectId === id).length   : (props.project.fileCount || 0)
  const folderCnt = fileCacheStore.loaded ? fileCacheStore.allFolders.filter(f => f.projectId === id).length : 0
  if (fileCnt + folderCnt > 0) {
    const parts = []
    if (fileCnt)   parts.push(`${fileCnt} 个文件`)
    if (folderCnt) parts.push(`${folderCnt} 个文件夹`)
    if (!window.confirm(`项目「${props.project.name}」中的 ${parts.join('、')} 将随项目一并删除。确定删除该项目吗？`)) return
  }
  await projectStore.deleteProject(id)
  if (fileCnt + folderCnt > 0) fileCacheStore.refresh()   // 该项目的文件/文件夹已随项目删除，重拉同步本地缓存
  closeProjectModal()
}

async function handleArchive() {
  if (!props.project) return
  await projectStore.archiveProject(props.project.id)
  closeProjectModal()
}

function saveStages() {
  if (props.project) projectStore.updateStages(props.project.id, localStages.value)
}



function saveTodos() {
  if (!props.project) return
  const newProgress = calcProgress(localStages.value, localCurrentStage.value)
  projectStore.saveTodos(props.project.id, localStages.value, newProgress)
}




const { uploadingItems, createGhost, updateGhostProgress, removeGhost, failGhost, createFolderGhost, bumpFolderGhost } = useUploadQueue()

// items: UploadItem[]（{file, relativePath}）——relativePath 带 "/" 时来自拖入的文件夹，
// 由通用上传生命周期按路径建好子文件夹再落到各自正确的 folder_id。
const conflictDialogRef = ref<{ show: (list: ConflictItem[]) => Promise<Map<string, ConflictDecision>> } | null>(null)

async function uploadFiles(items: UploadItem[]) {
  if (!items.length || !props.project) return
  const folder = currentFolder.value
  const baseFolderId = folder?.id ?? null

  // 上传前探测同名冲突（只查直接落在这个文件夹的顶层文件）；有冲突才弹列表式确认，
  // 选「跳过」的文件从这批里剔除，不会真的发上传请求。
  const prepared = await prepareUploadBatch(
    items,
    { space: 'project', projectId: props.project.id, folderId: baseFolderId },
    conflicts => conflictDialogRef.value?.show(conflicts) ?? Promise.resolve(new Map<string, ConflictDecision>()),
  )
  items = prepared.items
  const decisions = prepared.decisions
  if (!items.length) return

  const pendingTopFolders = new Map<string, FolderMeta>()
  await executeUploadLifecycle(items, {
    projectId: props.project.id,
    baseFolderId,
    folderGroups: prepared.folderGroups,
    decisions,
    createGhost,
    updateGhostProgress,
    removeGhost,
    failGhost,
    createFolderGhost,
    bumpFolderGhost,
    onFolderCreated: (created, isTopLevel) => {
      if (isTopLevel) pendingTopFolders.set(created.name, created as FolderMeta)
      else fileCacheStore.addFolder(created)
    },
    onTopFolderReady: name => {
      const folder = pendingTopFolders.get(name)
      if (folder) {
        fileCacheStore.addFolder(folder)
        pendingTopFolders.delete(name)
      }
    },
    uploadOne: async (file, resolvedFolderId, relativePath, decision, onProgress) => {
      const form = new FormData()
      form.append('file', file)
      form.append('space', 'project')
      form.append('project_id', String(props.project!.id))
      if (resolvedFolderId) form.append('folder_id', String(resolvedFolderId))
      const overwriteId = decision?.action === 'overwrite' ? decision.existingFileId : null
      if (overwriteId) {
        form.append('on_conflict', 'overwrite')
        form.append('overwrite_file_id', String(overwriteId))
      }
      const created = await uploadWithProgress('/files', form, onProgress)
      if (overwriteId) {
        if (created) fileCacheStore.updateFile(overwriteId, created)
        clearThumbCache(overwriteId)
      } else if (created) {
        fileCacheStore.addFile(created)
      }
    },
    onUploadError: e => console.error('[ProjectModal] 上传失败:', errMsg(e)),
  })
  // Tier 3：文件/文件夹都已随上传逐个进 store，视图与计数自动准确，无需再整层重拉校准。
}

async function handleFileInput(e: Event) {
  const target = e.target as HTMLInputElement
  await uploadFiles(filesToItems(target.files ?? []))
  target.value = ''
}

async function handleFileDrop(e: DragEvent) {
  dragging.value = false
  if (!e.dataTransfer) return
  const items = await readDroppedEntries(e.dataTransfer)
  await uploadFiles(items)
}

function onPmDragEnter(e: DragEvent) {
  if (e.dataTransfer?.types?.includes('Files')) pmDragCounter.value++
}
function onPmDragLeave() {
  pmDragCounter.value = Math.max(0, pmDragCounter.value - 1)
}
async function onPmDrop(e: DragEvent) {
  pmDragCounter.value = 0
  if (!e.dataTransfer) return
  const items = await readDroppedEntries(e.dataTransfer)
  if (items.length) await uploadFiles(items)
}

// ── 剪贴板 & 右键菜单（ProjectModal）──────────────────────────────────────────
const isMac = navigator.platform.toUpperCase().includes('MAC') || navigator.userAgent.includes('Mac')
const modKey = isMac ? '⌘' : 'Ctrl'
const pmCbStore = useClipboardStore()
const pmPasteBusy = ref(false)

function pmSelCut() {
  const fileIds = new Set(sortedCurrentFiles.value.map(file => file.id))
  const folderIds = new Set(sortedCurrentFolders.value.map(folder => folder.id))
  pmCbStore.cut(
    [...pmSelectedFileIds.value].filter(id => fileIds.has(id)),
    [...pmSelectedFolderIds.value].filter(id => folderIds.has(id)),
  )
  clearPmSelection()
}
function pmSelCopy() {
  const fileIds = new Set(sortedCurrentFiles.value.map(file => file.id))
  const folderIds = new Set(sortedCurrentFolders.value.map(folder => folder.id))
  pmCbStore.copy(
    [...new Set(pmSelectedFileIds.value)].filter(id => fileIds.has(id)),
    [...new Set(pmSelectedFolderIds.value)].filter(id => folderIds.has(id)),
  )
  clearPmSelection()
}
type PmCtxTarget = FileMeta | FolderMeta
type PmCtxType = 'file' | 'multi-file' | 'folder' | 'empty' | null
const { state: pmCtx, open: openProjectContextMenu } = useFileContextMenu<Exclude<PmCtxType, null>, PmCtxTarget>()
const pmInfoPopup = ref<{ show: boolean; file: FileMeta | null; x: number; y: number }>({ show: false, file: null, x: 0, y: 0 })

function openPmCtx(type: 'file' | 'folder' | 'empty', target: PmCtxTarget | null, e: MouseEvent) {
  let resolvedType: PmCtxType = type
  if (type === 'file' && target &&
      (pmSelectedFileIds.value.has(target.id) || pmSelectedFolderIds.value.size > 0) &&
      (pmSelectedFileIds.value.size + pmSelectedFolderIds.value.size) > 1) {
    resolvedType = 'multi-file'
  }
  openProjectContextMenu(resolvedType, target, e)
}

function handlePmCtxMenuAction(action: string) {
  const actions: Record<string, () => unknown> = {
    info: pmCtxInfo,
    download: pmCtxDownload,
    rename: pmCtxRename,
    cut: pmCtxCut,
    copy: pmCtxCopy,
    delete: pmCtxDelete,
    'download-folder': pmCtxDownloadFolder,
    'rename-folder': pmCtxRenameFolder,
    'cut-folder': pmCtxCutFolder,
    'delete-folder': pmCtxDeleteFolder,
    'create-folder': () => { pmCtx.value.visible = false; showNewFolder.value = true },
    paste: pmCtxPaste,
  }
  actions[action]?.()
}

function pmCurrentFolderId() {
  return folderStack.value.length ? folderStack.value[folderStack.value.length - 1].id : null
}

function pmCtxInfo() {
  const f = pmCtx.value.target as FileMeta | null
  pmCtx.value.visible = false
  if (f) pmInfoPopup.value = { show: true, file: f, x: pmCtx.value.x, y: pmCtx.value.y }
}

async function pmCtxDownload() {
  pmCtx.value.visible = false
  const target = pmCtx.value.target as FileMeta | null
  const ids = pmCtx.value.type === 'multi-file'
    ? [...pmSelectedFileIds.value] : (target ? [target.id] : [])
  if (ids.length === 1 && target) {
    await fileActions.downloadFile(target)
  } else {
    const fids = [...pmSelectedFolderIds.value]
    const dirName = folderStack.value.length
      ? folderStack.value[folderStack.value.length - 1].name
      : (props.project?.name ?? '文件')
    await fileActions.batchDownload(ids, fids, `${dirName}.zip`)
  }
}
function pmCtxRename() {
  const f = pmCtx.value.target as FileMeta | null; pmCtx.value.visible = false
  if (f) startRename(f)
}
function pmCtxCut() {
  const target = pmCtx.value.target
  const ids = pmCtx.value.type === 'multi-file' ? [...pmSelectedFileIds.value] : (target ? [target.id] : [])
  pmCbStore.cut(ids, []); pmCtx.value.visible = false
}
function pmCtxCopy() {
  const target = pmCtx.value.target
  const fileIds = pmCtx.value.type === 'multi-file'
    ? [...new Set(pmSelectedFileIds.value)]
    : (target && pmCtx.value.type === 'file' ? [target.id] : [])
  const folderIds = target && pmCtx.value.type === 'folder' ? [target.id] : []
  pmCbStore.copy(fileIds, folderIds); pmCtx.value.visible = false
}
async function pmCtxDelete() {
  const target = pmCtx.value.target
  const ids = pmCtx.value.type === 'multi-file' ? [...pmSelectedFileIds.value] : (target ? [target.id] : [])
  pmCtx.value.visible = false
  await Promise.all(ids.map(id => fileActions.deleteFile(id)))
  fileCacheStore.removeFiles(ids)   // 视图与文件夹计数自动更新
  clearPmSelection()
}

function pmCtxDownloadFolder() {
  const f = pmCtx.value.target as FolderMeta | null; pmCtx.value.visible = false
  if (f) downloadFolderZip(f)
}
function pmCtxRenameFolder() {
  const f = pmCtx.value.target as FolderMeta | null; pmCtx.value.visible = false
  if (f) startRenameFolder(f)
}
function pmCtxCutFolder() {
  const target = pmCtx.value.target
  pmCbStore.cut([], target ? [target.id] : []); pmCtx.value.visible = false
}
async function pmCtxDeleteFolder() {
  const f = pmCtx.value.target as FolderMeta | null; pmCtx.value.visible = false
  if (f) await deleteFolderCard(f)
}

async function pmCtxPaste() {
  if (pmPasteBusy.value) return
  pmPasteBusy.value = true
  pmCtx.value.visible = false
  const folderId  = pmCurrentFolderId() ?? null   // 当前所在文件夹 id；根目录为 null
  const projectId = props.project?.id ?? null
  try {
    const fileIds = [...new Set(pmCbStore.fileIds)]
    const folderIds = [...new Set(pmCbStore.folderIds
      .map(id => parseFolderId(id))
      .filter((id): id is number => id != null))]
    if (pmCbStore.type === 'cut') {
      // 剪切：文件改 folderId+projectId、文件夹改 parent 到当前层。更新 store 后，源层/目标层视图
      // 与文件夹计数都自动跟随（源层文件消失、目标层出现），不再需要逐层剔除/刷新。
      const [, movedFolders] = await Promise.all([
        Promise.all(fileIds.map(id => fileActions.moveFile(id, folderId, projectId))),
        Promise.all(folderIds.map(id =>
          fileActions.moveFolder(id, folderId, fileCacheStore.getFolder(id)?.version ?? 1, projectId))),
      ])
      fileIds.forEach(id => fileCacheStore.updateFile(id, { folderId, projectId }))
      movedFolders.forEach(f => fileCacheStore.updateFolder(f.id, { parentId: folderId, projectId, version: f.version }))
      pmCbStore.clear()
      await fileCacheStore.refresh()
    } else if (pmCbStore.type === 'copy') {
      const created = await Promise.all(fileIds.map(id => fileActions.copyFile(id, folderId, projectId)))
      created.forEach(c => { if (c) fileCacheStore.addFile(c) })
      const copiedFolders = await Promise.all(folderIds.map(id => fileActions.copyFolder(id, folderId ?? null, projectId ?? null)))
      copiedFolders.forEach(c => fileCacheStore.addFolder(c))
      await fileCacheStore.refresh()
    }
  } catch (e) { console.error('[PM] 粘贴失败:', e) }
  finally { pmPasteBusy.value = false }
}

function onPmKeyDown(e: KeyboardEvent) {
  // ProjectModal 在 DefaultLayout 中常驻挂载；未打开时不能参与文件库的全局快捷键。
  if (!props.project) return
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return
  const ctrl = e.ctrlKey || e.metaKey
  if (ctrl && e.key === 'x') {
    const fids = [...pmSelectedFileIds.value]; const dids = [...pmSelectedFolderIds.value]
    if (fids.length || dids.length) { pmCbStore.cut(fids, dids); e.preventDefault(); e.stopImmediatePropagation() }
  } else if (ctrl && e.key === 'c') {
    const fids = [...pmSelectedFileIds.value]
    if (fids.length) { pmCbStore.copy(fids, []); e.preventDefault(); e.stopImmediatePropagation() }
  } else if (ctrl && e.key === 'v') {
    if (pmCbStore.hasContent()) { pmCtxPaste(); e.preventDefault(); e.stopImmediatePropagation() }
  }
}

onMounted(() => document.addEventListener('keydown', onPmKeyDown, true))
onUnmounted(() => document.removeEventListener('keydown', onPmKeyDown, true))

const filePanelContext = {
  stagesExpanded,
  togglePmStages,
  pmCanGoBack,
  pmGoBack,
  pmCanGoForward,
  pmGoForward,
  pmNavigateTo,
  folderStack,
  pmBcDragOverIdx,
  pmCbStore,
  pmCtxPaste,
  pmInSelectionMode,
  togglePmSelectionMode,
  fileViewMode,
  showNewFolder,
  newFolderName,
  folderLoading,
  createFolder,
  folderInputRef,
  PM_SORT_OPTIONS,
  pmSortKey,
  pmSortDir,
  onPmSortSelect,
  closeProjectModal,
  pmIsDragging,
  pmSelectionRect,
  pmGridRef,
  onPmGridMouseDown,
  onPmContentClick,
  openPmCtx,
  onPmDragEnter,
  onPmDragLeave,
  onPmDrop,
  sortedCurrentFolders,
  pmFolderCount,
  accentColor,
  pmDragOverFolderId,
  pmSelectedFolderIds,
  pmPreviewFolderIds,
  onPmFolderClick,
  onPmFolderPointerDown,
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
  pmDraggingFileIds,
  renamingFileId,
  startRename,
  commitRename,
  renameText,
  cancelRename,
  thumbLoadedIds,
  downloadFile,
  deleteFile,
  pmHandleFileClick,
  onPmFilePointerDown,
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
:deep(.drp-input) {
  background: rgba(255,255,255,0.5);
}
:deep(.drp-input:hover) {
  background: rgba(255,255,255,0.75);
}

.modal {
  display: flex;
  width: 100%; height: 100%;
  overflow: hidden;
}
.modal button { outline: none; }

.close-btn {
  width: 28px; height: 28px; border-radius: 8px; flex-shrink: 0;
  background: rgba(0,0,0,0.07); border: none;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; color: var(--text-secondary); transition: background 0.15s;
}
.close-btn:hover { background: rgba(0,0,0,0.13); }

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
  scrollbar-gutter: stable;
}
.left-content::-webkit-scrollbar { width: 3px; }
.left-content::-webkit-scrollbar-track { background: transparent; }
.left-content::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.12); border-radius: 99px; }

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
  width: 100%; padding: 9px 12px; box-sizing: border-box;
  border: 1px solid rgba(0,0,0,0.1); border-radius: 8px;
  background: rgba(255,255,255,0.5); font-size: 13px;
  font-family: var(--font-sans); color: var(--text-primary);
  outline: none; transition: border-color 0.15s, box-shadow 0.15s;
}
.field-input:hover { border-color: rgba(123,127,178,0.35); background: rgba(255,255,255,0.75); box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 0 0 3px rgba(123,127,178,0.08); }
.field-input:focus { border-color: rgba(123,127,178,0.4); background: rgba(255,255,255,0.75); box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 0 0 3px rgba(123,127,178,0.1); }

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
.status-btn.s-done.active    .opt-dot { background: #5a9e88; }
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
