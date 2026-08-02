<template>
        <!-- 右栏：文件（两种模式都保持项目文件，仅宽度变化）-->
        <div class="modal-right">
          <!-- 两栏边缘切换：展开阶段区(50/50) / 恢复文件区 -->
          <button class="col-toggle-btn" @click="togglePmStages"
            :title="stagesExpanded ? '恢复文件区' : '展开阶段区'">
            <PhCaretLeft v-if="stagesExpanded" :size="13" weight="bold" />
            <PhCaretRight v-else :size="13" weight="bold" />
          </button>

          <div class="right-header">
            <!-- 面包屑路径 -->
            <FileBrowserBreadcrumb tag="nav" class-name="file-breadcrumb">
              <button class="pm-nav-hist-btn" :disabled="!pmCanGoBack" @click="pmGoBack" title="后退">
                <PhArrowLeft :size="13" weight="bold" />
              </button>
              <button class="pm-nav-hist-btn" :disabled="!pmCanGoForward" @click="pmGoForward" title="前进">
                <PhArrowRight :size="13" weight="bold" />
              </button>
              <button class="bc-seg" :class="{ 'bc-drop-target': pmBcDragOverIdx === -1 }"
                data-bc-idx="-1"
                @click="pmNavigateTo(-1)"
              >项目文件</button>
              <template v-for="(seg, idx) in folderStack" :key="seg.id">
                <PhCaretRight :size="10" weight="bold" class="bc-sep" />
                <button v-if="idx < folderStack.length - 1" class="bc-seg"
                  :class="{ 'bc-drop-target': pmBcDragOverIdx === idx }"
                  :data-bc-idx="idx"
                  @click="pmNavigateTo(idx)"
                >{{ seg.name }}</button>
                <span v-else class="bc-seg bc-cur">{{ seg.name }}</span>
              </template>
            </FileBrowserBreadcrumb>
            <!-- 粘贴（剪切/复制后出现）—— 放在所有按钮最左 -->
            <FilePasteButton
              v-if="pmCbStore.hasContent()"
              compact
              :count="pmCbStore.fileIds.length + pmCbStore.folderIds.length"
              @paste="pmCtxPaste"
            />
            <!-- 多选模式 -->
            <button class="sel-mode-btn" :class="{ on: pmInSelectionMode }" @click.stop="togglePmSelectionMode" title="多选模式">
              <PhCheckSquare :size="13" weight="bold" />
            </button>
            <!-- 视图切换 -->
            <SegmentedControl class="view-toggle" :active-index="fileViewMode === 'grid' ? 0 : 1"
              style="--pill-bg: rgba(255,255,255,0.85); --pill-radius: 6px">
              <button :class="{ on: fileViewMode === 'grid' }" @click="fileViewMode = 'grid'" title="网格视图">
                <PhSquaresFour :size="13" weight="bold" />
              </button>
              <button :class="{ on: fileViewMode === 'list' }" @click="fileViewMode = 'list'" title="列表视图">
                <PhList :size="13" weight="bold" />
              </button>
            </SegmentedControl>
            <!-- 新建文件夹（每层都可用） -->
            <button v-if="!showNewFolder" class="new-folder-btn" @click.stop="showNewFolder = true">
              <PhFolderPlus :size="13" weight="bold" />
              新建文件夹
            </button>
            <div v-else class="new-folder-inline" @click.stop>
              <input class="new-folder-input" v-model="newFolderName" placeholder="文件夹名称"
                v-enter="createFolder" @keyup.esc="showNewFolder = false; newFolderName = ''"
                ref="folderInputRef" autofocus />
              <button class="btn-confirm-sm" :disabled="folderLoading" @click="createFolder">确定</button>
              <button class="btn-cancel-sm" @click="showNewFolder = false; newFolderName = ''">✕</button>
            </div>
            <!-- 排序选择器（挪出 新建文件夹 的 v-if/v-else 对，否则 v-else 不相邻报错）-->
            <SortMenu
              ref="sortMenuRef"
              :options="PM_SORT_OPTIONS"
              :sort-key="pmSortKey"
              :sort-dir="pmSortDir"
              @select="onPmSortSelect"
            />
            <button class="close-btn" @click="closeProjectModal">
              <PhX :size="14" weight="bold" />
            </button>
          </div>

          <div class="file-content" ref="pmGridRef" style="position:relative" @mousedown="onPmGridMouseDown"
            @click="onPmContentClick"
            @contextmenu.prevent.self="openPmCtx('empty', null, $event)"
            @dragenter.prevent="onPmDragEnter"
            @dragover.prevent
            @dragleave="onPmDragLeave"
            @drop.prevent="onPmDrop">
            <Transition name="drop-fade">
              <div v-if="pmIsDragging" class="drop-overlay" @dragover.prevent @drop.prevent="onPmDrop" @dragleave.stop>
                <div class="drop-zone-hint">
                  <svg width="36" height="36" viewBox="0 0 44 44" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M22 30V16M15 22l7-7 7 7"/><path d="M8 36h28"/>
                  </svg>
                  <span class="drop-hint">松开以上传文件</span>
                </div>
              </div>
            </Transition>
            <div v-if="pmSelectionRect" class="pm-selection-rect" :style="{
              left: pmSelectionRect.left + 'px', top: pmSelectionRect.top + 'px',
              width: pmSelectionRect.width + 'px', height: pmSelectionRect.height + 'px',
            }"></div>
            <!-- ── 网格视图 ── -->
            <template v-if="fileViewMode === 'grid'">
              <FileBrowserGrid @empty-context="openPmCtx('empty', null, $event)">
                <!-- 文件夹卡片（当前层） -->
                <FolderCard v-for="folder in sortedCurrentFolders" :key="folder.id"
                  :display-name="folder.name"
                  :count-label="`${pmFolderCount(folder.id)} 个文件`"
                  :accent-color="accentColor"
                  :drag-over="pmDragOverFolderId === folder.id"
                  :selected="pmSelectedFolderIds.has(folder.id)"
                  :pre-selected="pmPreviewFolderIds.has(folder.id)"
                  :selection-mode="pmInSelectionMode"
                  :data-pm-folder-id="folder.id"
                  @click.stop="onPmFolderClick(folder, $event)"
                  @contextmenu.prevent.stop="openPmCtx('folder', folder, $event)"
                  @pointerdown="onPmFolderPointerDown(folder, $event)">
                  <template #icon>
                    <svg class="fd-big-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>
                    </svg>
                  </template>
                  <template #actions>
                    <button class="file-card-btn" :title="renamingFolderId === folder.id ? '确认' : '重命名'"
                      @mousedown.prevent @click.stop="renamingFolderId === folder.id ? commitFolderRename() : startRenameFolder(folder)">
                      <PhCheck v-if="renamingFolderId === folder.id" :size="10" weight="bold" />
                      <PhPencilSimple v-else :size="10" weight="bold" />
                    </button>
                    <button class="file-card-btn" title="下载为 ZIP" @click.stop="downloadFolderZip(folder)">
                      <PhDownloadSimple :size="10" weight="bold" />
                    </button>
                    <button class="file-card-btn del" title="删除" @click.stop="deleteFolderCard(folder)">
                      <PhTrash :size="10" weight="bold" />
                    </button>
                  </template>
                  <template #name>
                    <span :title="folder.name">
                      <span v-if="renamingFolderId === folder.id" class="rename-sizer" @click.stop>
                        <span class="rename-ghost">{{ folderRenameText || ' ' }}</span>
                        <input class="rename-input-inline" v-model="folderRenameText"
                          v-enter="commitFolderRename" @keydown.esc="cancelFolderRename" @blur="commitFolderRename" @focus="($event.target as HTMLInputElement).select()" />
                      </span>
                      <template v-else>{{ folder.name }}</template>
                    </span>
                  </template>
                </FolderCard>
                <!-- 文件卡片（当前层）：共用视觉走 FileCard.vue，跟文件库网格同一份组件，
                     不再各画一套图标/角标/缩略图/卡片外壳；本页专属的选择态/拖拽态/剪切态/
                     悬浮操作按钮走 props 和默认插槽。 -->
                <FileCard
                  v-for="file in sortedCurrentFiles" :key="file.id"
                  class="hover-card-fx"
                  :ext="file.ext" :display-name="file.displayName" :has-thumb="isPmImageExt(file.ext)"
                  :selected="pmSelectedFileIds.has(file.id)" :pre-selected="pmPreviewFileIds.has(file.id)"
                  :dragging="pmDraggingFileIds.has(file.id)" :cut="pmCbStore.type === 'cut' && pmCbStore.fileIds.includes(file.id)"
                  :data-pm-file-id="file.id"
                  @contextmenu.prevent.stop="openPmCtx('file', file, $event)"
                  @click.stop="pmHandleFileClick(file, $event)"
                  @pointerdown="onPmFilePointerDown(file, $event)">
                  <template #thumb>
                    <img class="fc-thumb-tiny" v-lazy-src="{ id: file.id, size: 'tiny' }" decoding="async" draggable="false" alt="" />
                    <img class="fc-thumb-full" v-lazy-src="{ id: file.id, size: 'card' }"
                      :class="{ 'fc-loaded': thumbLoadedIds.has(file.id) }"
                      decoding="async" draggable="false" alt=""
                      @load="thumbLoadedIds.add(file.id)"
                      @error="($event.target as HTMLElement).style.display='none'" />
                    <div class="fc-thumb-fade"></div>
                  </template>
                  <template #name>
                    <span v-if="renamingFileId === file.id" class="rename-sizer" @click.stop>
                      <span class="rename-ghost">{{ renameText || ' ' }}</span>
                      <input class="rename-input-inline" v-model="renameText"
                        v-enter="commitRename" @keydown.esc="cancelRename" @blur="commitRename" @focus="($event.target as HTMLInputElement).select()" />
                    </span>
                    <template v-else>{{ file.displayName }}</template>
                  </template>
                  <template #meta>{{ file.stageName ? file.stageName + ' · ' : '' }}{{ file.size }}</template>

                  <Transition name="sel-cb">
                    <div v-if="pmInSelectionMode" class="sel-checkbox" :class="{ checked: pmSelectedFileIds.has(file.id) }">
                      <PhCheck v-if="pmSelectedFileIds.has(file.id)" :size="10" weight="bold" style="color:white" />
                    </div>
                  </Transition>
                  <div class="fc-hover-actions" v-show="!pmInSelectionMode">
                    <button class="file-card-btn" :title="renamingFileId === file.id ? '确认' : '重命名'"
                      @mousedown.prevent @click.stop="renamingFileId === file.id ? commitRename() : startRename(file)">
                      <PhCheck v-if="renamingFileId === file.id" :size="10" weight="bold" />
                      <PhPencilSimple v-else :size="10" weight="bold" />
                    </button>
                    <button class="file-card-btn" title="下载" @click.stop="downloadFile(file)"><PhDownloadSimple :size="10" weight="bold" /></button>
                    <button class="file-card-btn del" title="删除" @click.stop="deleteFile(file)"><PhTrash :size="10" weight="bold" /></button>
                  </div>
                </FileCard>
                <!-- 幽灵上传卡片：单文件 / 文件夹（拖入文件夹时汇总一张） -->
                <FileUploadGhostCard v-for="g in uploadingItems" :key="g.uid"
                  :name="g.name" :ext="g.ext" :is-folder="g.isFolder" :progress="g.progress"
                  :done="g.done" :total="g.total" :failed="g.failed" :error="g.error" />
                <!-- 上传卡片 -->
                <FileUploadButton mode="grid" :dragging="dragging"
                  @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="handleFileDrop"
                  @select="handleFileInput" />
              </FileBrowserGrid>
            </template>

            <!-- ── 列表视图 ── -->
            <template v-else>
              <FileBrowserList class-name="file-list-view" @empty-context="openPmCtx('empty', null, $event)">
                <div class="list-head">
                  <span class="lh-sortable" :class="{ active: pmSortKey === 'name' }" @click.stop="onPmSortSelect('name')">名称<svg class="lh-arrow" :class="{ desc: pmSortDir === 'desc' }" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 2v6M2 5l3-3 3 3"/></svg></span>
                  <span class="lh-sortable" :class="{ active: pmSortKey === 'stage' }" @click.stop="onPmSortSelect('stage')">阶段<svg class="lh-arrow" :class="{ desc: pmSortDir === 'desc' }" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 2v6M2 5l3-3 3 3"/></svg></span>
                  <span class="lh-sortable" :class="{ active: pmSortKey === 'size' }" @click.stop="onPmSortSelect('size')">大小<svg class="lh-arrow" :class="{ desc: pmSortDir === 'desc' }" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 2v6M2 5l3-3 3 3"/></svg></span>
                  <span class="lh-sortable" :class="{ active: pmSortKey === 'createdAt' }" @click.stop="onPmSortSelect('createdAt')">日期<svg class="lh-arrow" :class="{ desc: pmSortDir === 'desc' }" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 2v6M2 5l3-3 3 3"/></svg></span>
                  <span></span>
                </div>
                <!-- 文件夹行（当前层） -->
                <div v-for="folder in sortedCurrentFolders" :key="folder.id"
                  class="list-row folder-list-row"
                  :class="{ 'drag-over': pmDragOverFolderId === folder.id, selected: pmSelectedFolderIds.has(folder.id), 'pre-selected': pmPreviewFolderIds.has(folder.id) }"
                  :data-pm-folder-id="folder.id"
                  @click.stop="onPmFolderClick(folder, $event)"
                  @contextmenu.prevent.stop="openPmCtx('folder', folder, $event)"
                  @pointerdown="onPmFolderPointerDown(folder, $event)">
                  <span class="lr-name-cell">
                    <PhFolder class="lr-folder-icon" :size="16" weight="fill" :style="{ color: accentColor }" />
                    <span class="lr-filename" :title="folder.name">
                      <span v-if="renamingFolderId === folder.id" class="rename-sizer" @click.stop>
                        <span class="rename-ghost">{{ folderRenameText || ' ' }}</span>
                        <input class="rename-input-inline" v-model="folderRenameText"
                          v-enter="commitFolderRename" @keydown.esc="cancelFolderRename" @blur="commitFolderRename" @focus="($event.target as HTMLInputElement).select()" />
                      </span>
                      <template v-else>{{ folder.name }}</template>
                    </span>
                  </span>
                  <span class="lr-text">—</span>
                  <span class="lr-text">{{ pmFolderCount(folder.id) }} 项</span>
                  <span class="lr-text">—</span>
                  <span class="lr-actions">
                    <Transition name="sel-cb">
                      <div v-if="pmInSelectionMode" class="sel-checkbox" :class="{ checked: pmSelectedFolderIds.has(folder.id) }">
                        <PhCheck v-if="pmSelectedFolderIds.has(folder.id)" :size="10" weight="bold" style="color:white" />
                      </div>
                    </Transition>
                    <template v-if="!pmInSelectionMode">
                      <button class="file-list-btn" :title="renamingFolderId === folder.id ? '确认' : '重命名'"
                        @mousedown.prevent @click.stop="renamingFolderId === folder.id ? commitFolderRename() : startRenameFolder(folder)">
                        <PhCheck v-if="renamingFolderId === folder.id" :size="11" weight="bold" />
                        <PhPencilSimple v-else :size="11" weight="bold" />
                      </button>
                      <button class="file-list-btn" title="下载为 ZIP" @click.stop="downloadFolderZip(folder)"><PhDownloadSimple :size="11" weight="bold" /></button>
                      <button class="file-list-btn del" title="删除" @click.stop="deleteFolderCard(folder)"><PhTrash :size="11" weight="bold" /></button>
                    </template>
                  </span>
                </div>
                <!-- 文件行（当前层） -->
                <div v-for="file in sortedCurrentFiles" :key="file.id"
                  class="list-row"
                  :class="{ selected: pmSelectedFileIds.has(file.id), 'pre-selected': pmPreviewFileIds.has(file.id), dragging: pmDraggingFileIds.has(file.id), cut: pmCbStore.type === 'cut' && pmCbStore.fileIds.includes(file.id) }"
                  :data-pm-file-id="file.id"
                  @contextmenu.prevent.stop="openPmCtx('file', file, $event)"
                  @click.stop="pmHandleFileClick(file, $event)"
                  @pointerdown="onPmFilePointerDown(file, $event)">
                  <span class="lr-name-cell">
                    <span class="lr-ext" :style="{ color: fileIconColor(file.ext), background: fileIconColor(file.ext) + '18' }">{{ file.ext }}</span>
                    <span class="lr-filename" :title="file.displayName">
                      <span v-if="renamingFileId === file.id" class="rename-sizer" @click.stop>
                        <span class="rename-ghost">{{ renameText || ' ' }}</span>
                        <input class="rename-input-inline" v-model="renameText"
                          v-enter="commitRename" @keydown.esc="cancelRename" @blur="commitRename" @focus="($event.target as HTMLInputElement).select()" />
                      </span>
                      <template v-else>{{ file.displayName }}</template>
                    </span>
                  </span>
                  <span class="lr-text">{{ file.stageName || '—' }}</span>
                  <span class="lr-text">{{ file.size }}</span>
                  <span class="lr-text">{{ file.createdAt }}</span>
                  <span class="lr-actions">
                    <Transition name="sel-cb">
                      <div v-if="pmInSelectionMode" class="sel-checkbox" :class="{ checked: pmSelectedFileIds.has(file.id) }">
                        <PhCheck v-if="pmSelectedFileIds.has(file.id)" :size="10" weight="bold" style="color:white" />
                      </div>
                    </Transition>
                    <template v-if="!pmInSelectionMode">
                      <button class="file-list-btn" :title="renamingFileId === file.id ? '确认' : '重命名'"
                        @mousedown.prevent @click.stop="renamingFileId === file.id ? commitRename() : startRename(file)">
                        <PhCheck v-if="renamingFileId === file.id" :size="11" weight="bold" />
                        <PhPencilSimple v-else :size="11" weight="bold" />
                      </button>
                      <button class="file-list-btn" title="下载" @click.stop="downloadFile(file)"><PhDownloadSimple :size="11" weight="bold" /></button>
                      <button class="file-list-btn del" title="删除" @click.stop="deleteFile(file)"><PhTrash :size="11" weight="bold" /></button>
                    </template>
                  </span>
                </div>
                <!-- 幽灵上传行：单文件 / 文件夹（拖入文件夹时汇总一行） -->
            <FileUploadGhostCard v-for="g in uploadingItems" :key="g.uid" mode="list" list-layout="project"
                  :name="g.name" :ext="g.ext" :is-folder="g.isFolder" :progress="g.progress"
                  :done="g.done" :total="g.total" :failed="g.failed" :error="g.error">
                  <template #list="{ color, statusText }">
                  <span class="lr-name-cell">
                    <span v-if="!g.isFolder" class="lr-ext" :style="{ color, background: color + '18' }">{{ g.ext || '—' }}</span>
                    <span class="lr-filename">{{ g.name }}</span>
                  </span>
                  <span class="lr-text">—</span>
                  <span class="lr-text">—</span>
                  <span class="lr-text">
                    {{ statusText }}
                  </span>
                  <span class="lr-actions"></span>
                  </template>
                </FileUploadGhostCard>
                <!-- 上传行 -->
                <FileUploadButton mode="list" :dragging="dragging"
                  @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="handleFileDrop"
                  @select="handleFileInput" />
              </FileBrowserList>
            </template>

            <!-- 批量操作浮动栏 -->
            <FileSelectionToolbar
              v-if="pmInSelectionMode"
              compact
              :file-count="pmSelectedFileIds.size"
              :folder-count="pmSelectedFolderIds.size"
              :downloading="pmDownloadingZip"
              @download="downloadSelectedPm"
              @cut="pmSelCut"
              @copy="pmSelCopy"
              @delete="deleteSelectedPm"
              @cancel="clearPmSelection"
            />
          </div>
        </div>
</template>

<script setup lang="ts">
import { type PropType } from 'vue'
import {
  PhFolder, PhArrowLeft, PhArrowRight, PhCaretLeft, PhCaretRight, PhSquaresFour, PhList,
  PhCheckSquare, PhFolderPlus, PhPencilSimple, PhDownloadSimple, PhX, PhCheck, PhTrash,
} from '@phosphor-icons/vue'
import SortMenu from '@/components/common/SortMenu.vue'
import FileSelectionToolbar from '@/components/common/FileSelectionToolbar.vue'
import FilePasteButton from '@/components/common/FilePasteButton.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import FileCard from '@/components/common/FileCard.vue'
import FolderCard from '@/components/common/FolderCard.vue'
import FileUploadGhostCard from '@/components/common/FileUploadGhostCard.vue'
import FileUploadButton from '@/components/common/FileUploadButton.vue'
import FileBrowserGrid from '@/components/common/FileBrowserGrid.vue'
import FileBrowserBreadcrumb from '@/components/common/FileBrowserBreadcrumb.vue'
import FileBrowserList from '@/components/common/FileBrowserList.vue'
import { vLazyThumb as vLazySrc } from '@/composables/useLazyThumb'

const props = defineProps({ context: { type: Object as PropType<Record<string, any>>, required: true } })
const {
  stagesExpanded, togglePmStages, pmCanGoBack, pmGoBack, pmCanGoForward, pmGoForward,
  pmNavigateTo, folderStack, pmBcDragOverIdx, pmCbStore, pmCtxPaste, pmInSelectionMode,
  togglePmSelectionMode, fileViewMode, showNewFolder, newFolderName, folderLoading, createFolder,
  folderInputRef, PM_SORT_OPTIONS, pmSortKey, pmSortDir, onPmSortSelect, closeProjectModal,
  pmIsDragging, pmSelectionRect, pmGridRef, onPmGridMouseDown, onPmContentClick, openPmCtx,
  onPmDragEnter, onPmDragLeave, onPmDrop, sortedCurrentFolders, pmFolderCount, accentColor,
  pmDragOverFolderId, pmSelectedFolderIds, pmPreviewFolderIds, onPmFolderClick, onPmFolderPointerDown,
  renamingFolderId, commitFolderRename, startRenameFolder, downloadFolderZip, deleteFolderCard,
  folderRenameText, cancelFolderRename, sortedCurrentFiles, isPmImageExt, pmSelectedFileIds,
  pmPreviewFileIds, pmDraggingFileIds, renamingFileId, startRename, commitRename, renameText,
  cancelRename, thumbLoadedIds, downloadFile, deleteFile, pmHandleFileClick, onPmFilePointerDown,
  uploadingItems, dragging, handleFileDrop, handleFileInput, fileIconColor, pmDownloadingZip,
  downloadSelectedPm, pmSelCut, pmSelCopy, deleteSelectedPm, clearPmSelection,
} = props.context
</script>

<style>
.modal-right {
  display: flex; flex-direction: column; min-height: 0;
  flex: 1 1 0; min-width: 0; position: relative;
  background: var(--panel-bg);
  backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98);
}
/* 切换期间临时关掉嵌套 backdrop-filter：它套在 .bm-card 的毛玻璃里、宽度又随动画变，
   会让外层整层毛玻璃在动画起止帧重栅格化 → 整个面板闪屏。切完恢复，静态时毛玻璃照常。 */
.project-modal-root.pm-switching .modal-right { backdrop-filter: none; -webkit-backdrop-filter: none; }

/* 两栏边缘切换按钮：贴在右栏左缘，随宽度动画一起移动 */
.col-toggle-btn {
  position: absolute; left: -7px; top: 50%; transform: translateY(-50%);
  z-index: 12; width: 12px; height: 48px; border-radius: 7px;
  border: 1px solid rgba(0,0,0,0.08);
  background: var(--panel-bg); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; color: var(--text-secondary);
  box-shadow: 0 2px 10px rgba(30,40,80,0.12);
  transition: color 0.15s, background 0.15s, box-shadow 0.15s;
}
/* 视觉窄、但向两侧各扩 2px 透明鼠标判定区，好点中又不和滚动条重叠 */
.col-toggle-btn::before {
  content: ''; position: absolute; left: -2px; right: -2px; top: -2px; bottom: -2px;
}
.col-toggle-btn:hover {
  color: var(--color-primary); background: rgba(255,255,255,0.92);
  box-shadow: 0 3px 14px rgba(123,127,178,0.25);
}

.right-header {
  height: 52px; box-sizing: border-box;
  padding: 0 12px 0 16px; border-bottom: 1px solid rgba(0,0,0,0.07);
  display: flex; align-items: center; gap: 8px; flex-shrink: 0;
}
.right-title { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.right-count { font-size: 11px; color: var(--text-secondary); flex: 1; }

/* 面包屑 */
.file-breadcrumb { display: flex; align-items: center; gap: 3px; flex: 1; min-width: 0; }
.pm-nav-hist-btn {
  display: flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; border-radius: 6px; border: none;
  background: none; cursor: pointer; color: var(--text-secondary);
  transition: all 0.13s; flex-shrink: 0;
}
.pm-nav-hist-btn:hover:not(:disabled) { background: rgba(0,0,0,0.06); color: var(--text-primary); }
.pm-nav-hist-btn:disabled { opacity: 0.25; cursor: default; }
.bc-seg {
  background: none; border: none; padding: 0; cursor: pointer;
  font-size: 13px; font-weight: 600; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 140px;
  padding-bottom: 2px; margin-bottom: -2px;
}
.bc-seg:hover { color: var(--accent, #7c6ef2); }
.bc-seg.bc-drop-target { background: rgba(123,127,178,0.15); color: var(--accent, #7c6ef2); border-radius: 6px; }
.bc-cur { cursor: default; color: var(--text-secondary); font-weight: 500; }
.bc-cur:hover { color: var(--text-secondary); }
.bc-sep { opacity: 0.4; flex-shrink: 0; }
.fc-empty { grid-column: 1/-1; padding: 32px 0; text-align: center; font-size: 12px; color: var(--text-secondary); opacity: 0.6; }


.file-content { flex: 1; overflow-y: auto; padding: 14px; user-select: none; position: relative; isolation: isolate; }

.file-grid {
  display: grid;
  /* Mode1：固定 5 列均分可用宽度，避免右侧留下空白 */
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
  align-content: start;
}
/* Mode2（文件区压窄）：卡片缩小，单行正好 4 个，宽高比与 mode1 完全一致（138:122） */
.project-modal-root.stages-expanded .file-grid {
  grid-template-columns: repeat(4, 1fr);
}
/* 整卡（fc-card + folder-card）用 aspect-ratio 保持 138:122，flex-column 让缩略图区弹性填充。
   .fc-card 现在是 FileCard.vue 组件渲染出来的，元素带的是它自己的 scoped 属性而不是这份
   <style> 的——Vue scoped CSS 默认只把属性选择器接在选择器链最后一节上，跨组件够不到子组件
   内部节点，所以这几条 .fc-card 相关都套 :deep() 主动放弃这份样式的 scoped 限制；.folder-card
   仍是本组件手写模板，不需要 :deep()。 */
.project-modal-root.stages-expanded .fc-card,
.project-modal-root.stages-expanded .folder-card {
  min-height: 0;
  aspect-ratio: 138 / 122;
  display: flex;
  flex-direction: column;
}
/* 缩略图/图标区弹性占满卡片扣除 label 后的剩余高度 */
.project-modal-root.stages-expanded .fc-thumb-area,
.project-modal-root.stages-expanded .fc-icon-area,
.project-modal-root.stages-expanded .fd-icon-area {
  flex: 1;
  height: auto;
  min-height: 0;
}
/* FileCard 的缩略图/图标区默认是 90px 且不可收缩；Mode2 卡片更窄时会把外框撑高，
   与可收缩的文件夹卡产生高度差。按 138:122 的卡片比例给文件卡预留约 70px 内容区，
   让图片、普通文件图标和文件夹卡共享同一行高。 */
.project-modal-root.stages-expanded .fc-thumb-area,
.project-modal-root.stages-expanded .fc-icon-area {
  flex: 0 0 70px;
  height: 70px;
}
.project-modal-root.stages-expanded .fc-big-icon { width: 52px; height: 52px; }
/* 上传按钮与幽灵卡取消固定 min-height，跟随卡片同比例；网格态上传按钮现在是
   FileUploadButton.vue 组件根节点（class="fub grid"），跟上面 .fc-card 一样需要 :deep()
   才能够到，类名也从 .fc-upload 改成 .fub.grid。 */
.project-modal-root.stages-expanded .fub.grid,
.project-modal-root.stages-expanded .fc-ghost { min-height: 0; aspect-ratio: 138 / 122; }
/* 物理拖影克隆体被挂到 body、脱离 .project-modal-root.stages-expanded 上下文 → 用克隆标记类补回 mode2 版式，
   否则拖影回落 mode1 的 min-height:122 尺寸，和面板里压扁的卡片对不上（克隆体外框高度由内联 rect 控制）。
   同上，.fc-card 相关的部分需要 :deep()——见上面 .project-modal-root.stages-expanded 那组同样的说明。
   这块是拖拽克隆体尺寸相关的边界情况，跟拖拽动画重构分支（codex-drag-animation-refactor）
   有交叉，后续对接那条分支时一并复核这里的克隆尺寸表现是否仍然正确。 */
.fc-card.pm-clone-expanded,
.folder-card.pm-clone-expanded { min-height: 0; display: flex; flex-direction: column; }
.pm-clone-expanded .fc-thumb-area,
.pm-clone-expanded .fc-icon-area,
.pm-clone-expanded .fd-icon-area { flex: 1; height: auto; min-height: 0; }
.pm-clone-expanded .fc-big-icon { width: 52px; height: 52px; }

/* 文件卡片：网格视图已改用共用组件 FileCard.vue（跟文件库同一份），卡片外壳/角标/
   缩略图容器/图标/标题/元信息不再在这里各画一份，见 FileCard.vue 自己的 scoped 样式。
   这里只保留缩略图淡入两层（tiny 模糊占位 + full 淡入）——两页各自的懒加载/加载态判断
   不同，不适合塞进共用组件；基础定位由 FileCard.vue 的 `.fc-thumb-area :deep(img)` 提供，
   这里只补 tiny/full 各自的滤镜和淡入时序。 */
.fc-thumb-tiny { filter: blur(10px); transform: scale(1.15); z-index: 1; }
.fc-thumb-full { z-index: 2; opacity: 0; transition: opacity 0.4s ease; }
.fc-thumb-full.fc-loaded { opacity: 1; }

/* 视图切换 & 新建文件夹（header 内） */
.view-toggle {
  background: rgba(0,0,0,0.05);
  border-radius: 8px; padding: 2px; gap: 2px;
  flex-shrink: 0;   /* 工具栏拥挤时不被挤压，否则按钮/带 viewBox 的 SVG 会缩成 2~3px（首屏/久置后布局最紧时最明显）*/
}
.view-toggle button {
  width: 28px; height: 28px; border-radius: 6px; border: none;
  background: none; cursor: pointer; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center; transition: background 0.15s, color 0.15s, box-shadow 0.15s;
  flex-shrink: 0;
}
.view-toggle button svg { flex-shrink: 0; }
.view-toggle button.on { color: var(--color-primary); }
.view-toggle button:hover { color: var(--color-primary); }
.new-folder-btn {
  display: flex; align-items: center; gap: 5px;
  height: 28px; padding: 0 11px; border-radius: 8px;
  border: 1px dashed rgba(0,0,0,0.15); background: rgba(255,255,255,0.5);
  font-size: 12px; font-weight: 600; color: var(--color-primary);
  cursor: pointer; font-family: var(--font-sans); transition: all 0.15s; white-space: nowrap;
}
.new-folder-btn:hover { border-color: var(--color-primary); background: rgba(123,127,178,0.06); }
.new-folder-inline { display: flex; gap: 5px; align-items: center; }
.new-folder-input {
  width: 110px; height: 30px; padding: 0 8px; border-radius: 8px; font-size: 12px;
  border: 1.5px solid rgba(123,127,178,0.4); background: rgba(255,255,255,0.9);
  color: var(--text-primary); outline: none; font-family: var(--font-sans);
}
.new-folder-input:focus { border-color: var(--color-primary); }
.btn-confirm-sm, .btn-cancel-sm {
  height: 30px; padding: 0 10px; border-radius: 8px; border: none;
  font-size: 12px; cursor: pointer; font-family: var(--font-sans);
}
.btn-confirm-sm { background: var(--color-primary); color: white; }
.btn-confirm-sm:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-cancel-sm  { background: rgba(0,0,0,0.07); color: var(--text-secondary); }

/* 展开的文件夹区 */
.folder-expanded { margin-bottom: 8px; }
.folder-expanded-label {
  display: flex; align-items: center; gap: 5px;
  font-size: 10px; font-weight: 600; color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: 0.06em; padding: 0 2px 6px;
}
.inner-empty { font-size: 11px; color: var(--text-secondary); grid-column: 1/-1; padding: 4px 2px; }

/* 卡片操作按钮（文件卡） */
.fc-hover-actions { position: absolute; top: 8px; right: 8px; z-index: 3; display: flex; gap: 3px; opacity: 0; transition: opacity 0.15s; }
.fc-card:hover .fc-hover-actions { opacity: 1; }

/* ── 批量操作浮动栏 ── */
.pm-selection-bar {
  position: absolute; bottom: 11px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 8px;
  padding: 8px 14px; border-radius: 12px;
  background: rgba(30,32,44,0.88);
  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 6px 24px rgba(0,0,0,0.22); z-index: 50; white-space: nowrap;
}
.pm-sel-count { font-size: 11px; color: rgba(255,255,255,0.7); }
.pm-sel-download-btn {
  display: flex; align-items: center; gap: 5px;
  padding: 5px 10px; border-radius: 7px; border: none;
  background: rgba(255,255,255,0.15); color: white;
  font-size: 11px; font-weight: 600; cursor: pointer; transition: background 0.15s;
}
.pm-sel-download-btn:hover { background: rgba(255,255,255,0.25); }
.pm-sel-download-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.pm-sel-delete-btn {
  display: flex; align-items: center; gap: 4px;
  padding: 5px 10px; border-radius: 7px; border: none;
  background: rgba(200,90,90,0.85); color: white;
  font-size: 11px; font-weight: 600; cursor: pointer; transition: background 0.15s;
}
.pm-sel-delete-btn:hover { background: rgba(200,90,90,1); }
.pm-sel-cancel-btn {
  padding: 5px 8px; border-radius: 7px; border: none;
  background: rgba(255,255,255,0.12); color: rgba(255,255,255,0.7);
  font-size: 11px; cursor: pointer; transition: background 0.15s;
}
.pm-sel-action-btn {
  display: flex; align-items: center; gap: 4px;
  padding: 5px 10px; border-radius: 7px; border: none;
  background: rgba(255,255,255,0.12); color: rgba(255,255,255,0.9);
  font-size: 11px; font-weight: 500; cursor: pointer; transition: background 0.15s;
}
.pm-sel-action-btn:hover { background: rgba(255,255,255,0.22); }
.sel-divider { width: 1px; height: 16px; background: rgba(255,255,255,0.18); margin: 0 2px; flex-shrink: 0; }
.pm-sel-cancel-btn:hover { background: rgba(255,255,255,0.2); color: white; }
.pm-action-bar-enter-active, .pm-action-bar-leave-active { transition: opacity 0.2s; }
.pm-action-bar-enter-from, .pm-action-bar-leave-to { opacity: 0; }

/* ── 框选矩形 ── */
.pm-selection-rect {
  position: absolute; pointer-events: none; z-index: 30;
  border: 1.5px solid rgba(123,127,178,0.55);
  background: rgba(123,127,178,0.08); border-radius: 4px;
}

/* ── 拖动 / 选中状态 ──
   .fc-card 的选中/预选/拖拽态现在完全由 FileCard.vue 自己的 props+scoped 样式提供（跟文件库
   同一份，数值本来就抄自这里），不用再手写一份——写了也够不到子组件内部，见上面 :deep() 的说明。
   这里只留 .list-row（列表视图，未改造）需要的部分。 */
.list-row.dragging { opacity: 0.35; cursor: grabbing; }
.list-row.folder-list-row.drag-over {
  background: rgba(123,127,178,0.08);
  outline: 1.5px solid var(--color-primary); outline-offset: -1px;
}

/* 列表视图 */
.file-list-view { display: flex; flex-direction: column; gap: 2px; }

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
  display: grid; grid-template-columns: 1fr 80px 60px 70px 72px;
  padding: 0 10px 6px; font-size: 10px; font-weight: 600;
  color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.06em;
  border-bottom: 1px solid rgba(0,0,0,0.06);
}
.list-row {
  display: grid; grid-template-columns: 1fr 80px 60px 70px 72px;
  align-items: center; padding: 7px 10px; border-radius: 9px;
  min-height: 42px;
  cursor: pointer; transition: background 0.12s;
}
.list-row:hover { background: rgba(123,127,178,0.06); }
.list-row.selected { background: rgba(123,127,178,0.1); }
.list-row.pre-selected { background: rgba(123,127,178,0.06); outline: 1px solid rgba(123,127,178,0.25); }
.folder-list-row { cursor: pointer; }
.indented-row { padding-left: 28px; }
.lr-name-cell { display: flex; align-items: center; gap: 7px; min-width: 0; }
.lr-folder-icon, .lr-file-icon { flex-shrink: 0; opacity: 0.82; }
.lr-ext {
  font-size: 8px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase;
  border-radius: 3px; padding: 1px 4px; flex-shrink: 0; line-height: 1.5;
}
.lr-filename {
  font-size: 12px; font-weight: 600; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  flex: 1; min-width: 0; padding-bottom: 2px; margin-bottom: -2px;
}
.lr-text { font-size: 11px; color: var(--text-secondary); white-space: nowrap; }
.lr-actions { display: flex; gap: 2px; align-items: center; justify-content: flex-end; position: relative; }
.list-row:hover .file-list-btn { opacity: 1; }

/* 多选勾选框 */
.sel-checkbox {
  position: absolute; top: 6px; right: 6px; z-index: 3;
  width: 16px; height: 16px; border-radius: 4px;
  border: 2px solid rgba(123, 127, 178, 0.55);
  background: rgba(255,255,255,0.75);
  display: flex; align-items: center; justify-content: center;
  pointer-events: none;
  transition: background 0.15s, border-color 0.15s;
}
.sel-checkbox.checked {
  background: var(--color-primary, #7b7fb2);
  border-color: var(--color-primary, #7b7fb2);
}
/* 列表视图内勾选框：脱离 flex 流 */
.lr-actions .sel-checkbox {
  position: absolute; right: 0; top: 50%; transform: translateY(-50%);
  background: rgba(255,255,255,0.55);
  transition: background 0.15s, border-color 0.15s, opacity 0.18s ease;
}
.lr-actions .sel-checkbox.checked {
  background: var(--color-primary, #7b7fb2);
  border-color: var(--color-primary, #7b7fb2);
}
/* 淡入淡出动画 */
.sel-cb-enter-active, .sel-cb-leave-active {
  transition: background 0.15s, border-color 0.15s, opacity 0.18s ease;
}
.sel-cb-enter-from, .sel-cb-leave-to { opacity: 0; }

/* 多选模式按钮 */
.sel-mode-btn {
  width: 28px; height: 28px; border-radius: 6px; border: none;
  background: rgba(0,0,0,0.05); color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.15s, color 0.15s, box-shadow 0.15s;
}
.sel-mode-btn svg { display: block; }
.sel-mode-btn.on {
  background: rgba(255,255,255,0.85);
  color: var(--color-primary);
  box-shadow: 0 1px 4px rgba(0,0,0,0.08);
}
.sel-mode-btn:not(.on):hover { background: rgba(0,0,0,0.09); color: var(--text-primary); }

.paste-btn {
  display: flex; align-items: center; gap: 5px;
  height: 28px; padding: 0 12px; border-radius: 8px; border: none;
  background: rgba(255,255,255,0.55); cursor: pointer; color: var(--color-primary);
  font-size: 12px; font-weight: 600; font-family: var(--font-sans); white-space: nowrap;
  transition: background 0.15s, box-shadow 0.15s;
}
.paste-btn:hover { background: rgba(255,255,255,0.82); box-shadow: 0 1px 4px rgba(123,127,178,0.18); }
.paste-btn svg { display: block; }
.lr-chev { transition: transform 0.2s; opacity: 0.5; }
.lr-chev.open { transform: rotate(180deg); }
.list-row-empty { font-size: 11px; color: var(--text-secondary); padding: 4px 28px; }
/* 网格/列表上传按钮外观改由共用组件 FileUploadButton.vue 提供（跟文件库同一份）。 */
</style>

<style>
.list-row.cut { opacity: 0.75; }

.drop-overlay {
  position: absolute; inset: 0; z-index: 50;
  background: rgba(232,233,238,0.82);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  border-radius: inherit;
  corner-shape: inherit;   /* 跟随父级圆角形状，否则与父级 squircle 圆角不重合 → 双层圆角 */
  display: flex; align-items: center; justify-content: center;
  pointer-events: none;
}
.drop-zone-hint {
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  padding: 32px 50px;
  background: rgba(255,255,255,0.72);
  border: 2px dashed rgba(123,127,178,0.45); border-radius: 16px;
  color: var(--color-primary);
}
.drop-hint { font-size: 14px; font-weight: 700; color: var(--text-primary); }
.drop-fade-enter-active, .drop-fade-leave-active { transition: opacity 0.18s; }
.drop-fade-enter-from, .drop-fade-leave-to { opacity: 0; }
</style>
