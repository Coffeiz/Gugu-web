<template>
        <!-- 右栏：文件（两种模式都保持项目文件，仅宽度变化）-->
        <FileBrowserPanel class="modal-right">
          <template #toolbar>
            <ProjectFileToolbar :context="props.context" />
          </template>

          <div class="file-content scroll-surface" :ref="bindPmGridEl" style="position:relative" @mousedown="onPmGridMouseDown"
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
              <FileBrowserGrid :layout-collection="layoutCollection" @empty-context="openPmCtx('empty', null, $event)">
                <!-- 文件夹卡片（当前层） -->
                <RuntimeFolderCard v-for="folder in sortedCurrentFolders" :key="folder.id"
                  :card-props="{ displayName: folder.name, countLabel: `${pmFolderCount(folder.id)} 个文件`, accentColor, selected: pmSelectedFolderIds.has(folder.id), preSelected: pmPreviewFolderIds.has(folder.id), selectionMode: pmInSelectionMode }"
                  :runtime-id="fileObjectId(runtimeScope, 'folder', folder.id)"
                  :runtime-surface-id="browserSurfaceId(runtimeScope)"
                  :runtime-selected="pmSelectedFolderIds.has(folder.id)"
                  :runtime-target="{ surfaceId: folderSurfaceId(runtimeScope, folder.id), accepts: ['file-item', 'folder-item'], priority: 2 }"
                  :data-pm-folder-id="folder.id"
                  data-layout-role="card" :data-layout-key="folderLayoutKey(folder)"
                  @click.stop="onPmFolderClick(folder, $event)"
                  @contextmenu.prevent.stop="openPmCtx('folder', folder, $event)"
                  >
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
                </RuntimeFolderCard>
                <!-- 文件卡片（当前层）：共用视觉走 FileCard.vue，跟文件库网格同一份组件，
                     不再各画一套图标/角标/缩略图/卡片外壳；本页专属的选择态/拖拽态/剪切态/
                     悬浮操作按钮走 props 和默认插槽。 -->
                <RuntimeFileCard
                  v-for="file in sortedCurrentFiles" :key="file.id"
                  class="hover-card-fx"
                  :card-props="{ ext: file.ext, displayName: file.displayName, hasThumb: isPmImageExt(file.ext), selected: pmSelectedFileIds.has(file.id), preSelected: pmPreviewFileIds.has(file.id), cut: pmCbStore.type === 'cut' && pmCbStore.fileIds.includes(file.id) }"
                  :runtime-id="fileObjectId(runtimeScope, 'file', file.id)"
                  :runtime-surface-id="browserSurfaceId(runtimeScope)"
                  :runtime-selected="pmSelectedFileIds.has(file.id)"
                  :runtime-abilities="['move']"
                  :data-pm-file-id="file.id"
                  data-layout-role="card" :data-layout-key="fileLayoutKey(file)"
                  @contextmenu.prevent.stop="openPmCtx('file', file, $event)"
                  @click.stop="pmHandleFileClick(file, $event)"
                  >
                  <template #thumb>
                    <img class="fc-thumb-tiny" v-lazy-src="{ id: file.id, size: 'tiny', revision: file.thumbRevision }" decoding="async" draggable="false" alt="" />
                    <img class="fc-thumb-full" v-lazy-src="{ id: file.id, size: 'card', revision: file.thumbRevision }"
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
                </RuntimeFileCard>
                <!-- 幽灵上传卡片：单文件 / 文件夹（拖入文件夹时汇总一张） -->
                <FileUploadGhostCard v-for="g in uploadingItems" :key="g.uid"
                  :name="g.name" :ext="g.ext" :is-folder="g.isFolder" :progress="g.progress"
                  :done="g.done" :total="g.total" :failed="g.failed" :error="g.error"
                  data-flip-target />
                <!-- 上传卡片 -->
                <FileUploadButton mode="grid" :dragging="dragging"
                  data-flip-target
                  @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="handleFileDrop"
                  @select="handleFileInput" />
              </FileBrowserGrid>
            </template>

            <!-- ── 列表视图 ── -->
            <template v-else>
              <FileBrowserList class-name="file-list-view" :layout-collection="layoutCollection" @empty-context="openPmCtx('empty', null, $event)">
                <div class="list-head">
                  <span class="lh-sortable" :class="{ active: pmSortKey === 'name' }" @click.stop="onPmSortSelect('name')">名称<svg class="lh-arrow" :class="{ desc: pmSortDir === 'desc' }" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 2v6M2 5l3-3 3 3"/></svg></span>
                  <span class="lh-sortable" :class="{ active: pmSortKey === 'stage' }" @click.stop="onPmSortSelect('stage')">阶段<svg class="lh-arrow" :class="{ desc: pmSortDir === 'desc' }" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 2v6M2 5l3-3 3 3"/></svg></span>
                  <span class="lh-sortable" :class="{ active: pmSortKey === 'size' }" @click.stop="onPmSortSelect('size')">大小<svg class="lh-arrow" :class="{ desc: pmSortDir === 'desc' }" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 2v6M2 5l3-3 3 3"/></svg></span>
                  <span class="lh-sortable" :class="{ active: pmSortKey === 'createdAt' }" @click.stop="onPmSortSelect('createdAt')">日期<svg class="lh-arrow" :class="{ desc: pmSortDir === 'desc' }" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 2v6M2 5l3-3 3 3"/></svg></span>
                  <span></span>
                </div>
                <!-- 文件夹行（当前层） -->
                <RuntimeListRow v-for="folder in sortedCurrentFolders" :key="folder.id"
                  :runtime-id="fileObjectId(runtimeScope, 'folder', folder.id)"
                  :runtime-type="'folder-item'"
                  :runtime-surface-id="browserSurfaceId(runtimeScope)"
                  :runtime-selected="pmSelectedFolderIds.has(folder.id)"
                  :runtime-target="{ surfaceId: folderSurfaceId(runtimeScope, folder.id), accepts: ['file-item', 'folder-item'], priority: 2 }"
                  class="list-row folder-list-row"
                  :class="{ selected: pmSelectedFolderIds.has(folder.id), 'pre-selected': pmPreviewFolderIds.has(folder.id) }"
                  :data-pm-folder-id="folder.id"
                  data-layout-role="card" :data-layout-key="folderLayoutKey(folder)"
                  @click.stop="onPmFolderClick(folder, $event)"
                  @contextmenu.prevent.stop="openPmCtx('folder', folder, $event)"
                  >
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
                </RuntimeListRow>
                <!-- 文件行（当前层） -->
                <RuntimeListRow v-for="file in sortedCurrentFiles" :key="file.id"
                  :runtime-id="fileObjectId(runtimeScope, 'file', file.id)"
                  :runtime-type="'file-item'"
                  :runtime-surface-id="browserSurfaceId(runtimeScope)"
                  :runtime-selected="pmSelectedFileIds.has(file.id)"
                  :runtime-abilities="['move']"
                  class="list-row"
                  :class="{ selected: pmSelectedFileIds.has(file.id), 'pre-selected': pmPreviewFileIds.has(file.id), cut: pmCbStore.type === 'cut' && pmCbStore.fileIds.includes(file.id) }"
                  :data-pm-file-id="file.id"
                  data-layout-role="card" :data-layout-key="fileLayoutKey(file)"
                  @contextmenu.prevent.stop="openPmCtx('file', file, $event)"
                  @click.stop="pmHandleFileClick(file, $event)"
                  >
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
                </RuntimeListRow>
                <!-- 幽灵上传行：单文件 / 文件夹（拖入文件夹时汇总一行） -->
                <FileUploadGhostCard v-for="g in uploadingItems" :key="g.uid" mode="list" list-layout="project"
                  :name="g.name" :ext="g.ext" :is-folder="g.isFolder" :progress="g.progress"
                  :done="g.done" :total="g.total" :failed="g.failed" :error="g.error"
                  data-flip-target>
                  <template #list="{ color, statusText }">
                    <span class="lr-name-cell">
                      <span v-if="!g.isFolder" class="lr-ext" :style="{ color, background: color + '18' }">{{ g.ext || '—' }}</span>
                      <span class="lr-filename">{{ g.name }}</span>
                    </span>
                    <span class="lr-text">—</span>
                    <span class="lr-text">—</span>
                    <span class="lr-text">{{ statusText }}</span>
                    <span class="lr-actions"></span>
                  </template>
                </FileUploadGhostCard>
                <!-- 上传行 -->
                <FileUploadButton mode="list" :dragging="dragging"
                  data-flip-target
                  @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="handleFileDrop"
                  @select="handleFileInput" />
              </FileBrowserList>
            </template>
          </div>

          <!-- 批量栏挂在 modal-right，而不是可滚动/隔离的 file-content 内。
               modal-right 自身随编辑卡实际高度变化，absolute bottom 因而自然跟随动态高度，
               同时不会被 file-content 的 overflow / isolation 裁剪。 -->
          <FileSelectionToolbar
            v-if="pmInSelectionMode && (pmSelectedFileIds.size > 0 || pmSelectedFolderIds.size > 0)"
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
        </FileBrowserPanel>
</template>

<script setup lang="ts">
import { type PropType } from 'vue'
import { PhFolder, PhPencilSimple, PhDownloadSimple, PhCheck, PhTrash } from '@phosphor-icons/vue'
import FileSelectionToolbar from '@/components/common/FileSelectionToolbar.vue'
import RuntimeFileCard from '@/components/common/file-browser/RuntimeFileCard.vue'
import RuntimeFolderCard from '@/components/common/file-browser/RuntimeFolderCard.vue'
import RuntimeListRow from '@/components/common/file-browser/RuntimeListRow.vue'
import { fileObjectId, browserSurfaceId, folderSurfaceId } from '@/interaction/runtime/adapters/file/fileRuntimeAdapter'
import FileUploadGhostCard from '@/components/common/file-browser/FileUploadGhostCard.vue'
import FileUploadButton from '@/components/common/file-browser/FileUploadButton.vue'
import FileBrowserGrid from '@/components/common/file-browser/FileBrowserGrid.vue'
import FileBrowserList from '@/components/common/file-browser/FileBrowserList.vue'
import FileBrowserPanel from '@/components/common/file-browser/FileBrowserPanel.vue'
import ProjectFileToolbar from '@/views/Projects/components/ProjectFileToolbar.vue'
import { vLazyThumb as vLazySrc } from '@/composables/useLazyThumb'

const props = defineProps({ context: { type: Object as PropType<Record<string, any>>, required: true } })
const {
  fileViewMode, pmInSelectionMode,
  pmIsDragging, pmSelectionRect, bindPmGridEl, onPmGridMouseDown, onPmContentClick, openPmCtx,
  onPmDragEnter, onPmDragLeave, onPmDrop, sortedCurrentFolders, pmFolderCount, accentColor,
  folderLayoutKey, fileLayoutKey, layoutCollection,
  pmSelectedFolderIds, pmPreviewFolderIds, onPmFolderClick, runtimeScope,
  renamingFolderId, commitFolderRename, startRenameFolder, downloadFolderZip, deleteFolderCard,
  folderRenameText, cancelFolderRename, sortedCurrentFiles, isPmImageExt, pmSelectedFileIds,
  pmPreviewFileIds, renamingFileId, startRename, commitRename, renameText,
  cancelRename, thumbLoadedIds, downloadFile, deleteFile, pmHandleFileClick,
  uploadingItems, dragging, handleFileDrop, handleFileInput, fileIconColor, pmDownloadingZip,
  downloadSelectedPm, pmSelCut, pmSelCopy, deleteSelectedPm, clearPmSelection, pmCbStore,
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

/* 两栏边缘切换按钮由 ProjectFileToolbar 渲染，但定位基准属于右栏宿主。 */
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
/* 整卡（fc-card + folder-card）用 aspect-ratio 保持 138:122，flex-column 让缩略图区弹性填充。 */
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
   与可收缩的文件夹卡产生高度差。按 138:122 的卡片比例给文件卡预留约 70px 内容区。 */
.project-modal-root.stages-expanded .fc-thumb-area,
.project-modal-root.stages-expanded .fc-icon-area {
  flex: 0 0 70px;
  height: 70px;
}
.project-modal-root.stages-expanded .fc-big-icon { width: 52px; height: 52px; }
.project-modal-root.stages-expanded .fub.grid,
.project-modal-root.stages-expanded .fc-ghost { min-height: 0; aspect-ratio: 138 / 122; }
/* 物理拖影克隆体被挂到 body、脱离 stages-expanded 上下文，用克隆标记补回 mode2 版式。 */
.fc-card.pm-clone-expanded,
.folder-card.pm-clone-expanded { min-height: 0; display: flex; flex-direction: column; }
.pm-clone-expanded .fc-thumb-area,
.pm-clone-expanded .fc-icon-area,
.pm-clone-expanded .fd-icon-area { flex: 1; height: auto; min-height: 0; }
.pm-clone-expanded .fc-big-icon { width: 52px; height: 52px; }

/* 文件卡片：网格视图已改用共用组件 FileCard.vue；这里只保留缩略图淡入两层。 */
.fc-thumb-tiny { filter: blur(10px); transform: scale(1.15); z-index: 1; }
.fc-thumb-full { z-index: 2; opacity: 0; transition: opacity 0.4s ease; }
.fc-thumb-full.fc-loaded { opacity: 1; }

/* 卡片操作按钮（文件卡） */
.fc-hover-actions { position: absolute; top: 8px; right: 8px; z-index: 3; display: flex; gap: 3px; opacity: 0; transition: opacity 0.15s; }
.fc-card:hover .fc-hover-actions { opacity: 1; }

/* ── 框选矩形 ── */
.pm-selection-rect {
  position: absolute; pointer-events: none; z-index: 30;
  border: 1.5px solid rgba(123,127,178,0.55);
  background: rgba(123,127,178,0.08); border-radius: 4px;
}

/* ── 列表视图：只覆盖项目编辑卡的列数（5 列 vs 文件库 6 列），
       单元格样式（.lr-* / .sel-checkbox / .sel-cb-*）统一由 filesListRows.css 拥有，
       禁止在这里重复声明，避免 CSS 竞态。 ── */
.file-list-view .list-head {
  grid-template-columns: 1fr 80px 60px 70px 72px;
}
.file-list-view .list-row {
  grid-template-columns: 1fr 80px 60px 70px 72px;
}
</style>

<style>
.list-row.cut { opacity: 0.45; }

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
  padding: 32px 50px;
  background: rgba(255,255,255,0.72);
  border: 2px dashed rgba(123,127,178,0.45); border-radius: 16px;
  color: var(--color-primary);
}
.drop-hint { font-size: 14px; font-weight: 700; color: var(--text-primary); }
.drop-fade-enter-active, .drop-fade-leave-active { transition: opacity 0.18s; }
.drop-fade-enter-from, .drop-fade-leave-to { opacity: 0; }
</style>
