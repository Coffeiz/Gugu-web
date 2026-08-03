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

        <!-- ── 内容区（导航切换时淡入） ── -->
        <Transition name="content-fade" mode="out-in">
        <div :key="JSON.stringify(navPath)" class="content-body">

        <!-- ── 回收站视图 ── -->
        <template v-if="currentType === 'trash'">
          <div v-if="trashFolders.length > 0 || contents.files.length > 0" class="file-list trash-list">
            <div class="list-head">
              <span class="lh-sortable" :class="{ active: sortKey === 'name' }" @click="onSortSelect('name')">名称<svg class="lh-arrow" :class="{ desc: sortDir === 'desc' }" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 2v6M2 5l3-3 3 3"/></svg></span>
              <span>类型</span>
              <span class="lh-sortable" :class="{ active: sortKey === 'createdAt' }" @click="onSortSelect('createdAt')">删除时间<svg class="lh-arrow" :class="{ desc: sortDir === 'desc' }" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 2v6M2 5l3-3 3 3"/></svg></span>
              <span>剩余</span>
              <span class="lh-sortable" :class="{ active: sortKey === 'size' }" @click="onSortSelect('size')">大小<svg class="lh-arrow" :class="{ desc: sortDir === 'desc' }" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 2v6M2 5l3-3 3 3"/></svg></span>
              <span></span>
            </div>
            <template v-for="folder in sortedTrashFolders" :key="`trash-folder-${folder.id}`">
            <div class="list-row trash-folder-row" :data-trash-folder-id="`trash:${folder.id}`" :class="{ expanded: expandedTrashFolders.has(folder.id), selected: selectedTrashFolderIds.has(folder.id), 'pre-selected': previewFolderKeys.has(`trash:${folder.id}`) }" @click.stop="handleTrashFolderClick(folder, $event)">
              <span class="lr-name-cell">
                <button class="trash-expand-btn" :title="expandedTrashFolders.has(folder.id) ? '收起内容' : '查看内容'" @click.stop="toggleTrashFolder(folder)">
                  <svg :class="{ rotated: expandedTrashFolders.has(folder.id) }" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                    <path d="M2 3.5l3 3 3-3"/>
                  </svg>
                </button>
                <PhFolder class="lr-folder-icon" :size="16" weight="fill" />
                <span class="lr-filename" :title="folder.name">{{ folder.name }}</span>
              </span>
              <span class="lr-type-cell"><span class="lr-type-text">文件夹</span></span>
              <span class="lr-text">{{ formatDate(folder.deletedAt) }}</span>
              <span class="lr-text" :class="{ 'days-warn': daysLeft(folder.deletedAt) <= 3 }">{{ daysLeft(folder.deletedAt) }} 天</span>
              <span class="lr-text">{{ folder.fileCount }} 个文件</span>
              <span class="lr-actions">
                <Transition name="sel-cb"><div v-if="inSelectionMode" class="sel-checkbox" :class="{ checked: selectedTrashFolderIds.has(folder.id) }"><svg v-if="selectedTrashFolderIds.has(folder.id)" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6l3 3 5-5"/></svg></div></Transition>
                <template v-if="!inSelectionMode">
                <button class="file-list-btn trash-restore-btn" title="恢复文件夹及其内容" @click.stop="restoreTrashFolder(folder)">
                  <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M2 7A5 5 0 1 0 7 2"/><path d="M2 2v5h5"/>
                  </svg>
                  恢复
                </button>
                <button class="file-list-btn del" title="永久删除文件夹及其内容" @click.stop="hardDeleteTrashFolder(folder)">
                  <PhTrash :size="11" weight="bold" />
                </button>
                </template>
              </span>
            </div>
            <div v-if="expandedTrashFolders.has(folder.id)" class="trash-folder-contents">
              <div v-if="trashFolderContents[folder.id]?.folders.length === 0 && trashFolderContents[folder.id]?.files.length === 0" class="trash-folder-empty">空文件夹</div>
              <div v-for="child in trashFolderContents[folder.id]?.folders || []" :key="`trash-child-${child.id}`" class="trash-child-row">
                <PhFolder :size="14" weight="fill" /> <span>{{ child.name }}</span><small>{{ child.fileCount }} 个文件</small>
              </div>
              <div v-for="file in trashFolderContents[folder.id]?.files || []" :key="`trash-child-file-${file.id}`" class="trash-child-row file">
                <component :is="fileListIcon(file.ext)" :size="14" weight="fill" :style="{ color: fileIconColor(file.ext) }" /> <span>{{ file.displayName }}.{{ file.ext.toLowerCase() }}</span>
              </div>
            </div>
            </template>
            <div v-for="f in sortedContents.files" :key="f.id" class="list-row"
              :data-file-id="f.id"
              :class="{ selected: selectedIds.has(f.id), 'pre-selected': previewFileIds.has(f.id) }"
              @click.stop="handleTrashFileClick(f, $event)">
              <span class="lr-name-cell">
                <component :is="fileListIcon(f.ext)" class="lr-file-icon" :size="16" weight="fill" :style="{ color: fileIconColor(f.ext) }" />
                <span class="lr-filename" :title="f.displayName">{{ f.displayName }}</span>
              </span>
              <span class="lr-type-cell">
                <span class="lr-ext" :style="{ color: fileIconColor(f.ext), background: fileIconColor(f.ext) + '18' }">{{ f.ext }}</span>
              </span>
              <span class="lr-text">{{ f.deletedAt ? formatDate(f.deletedAt) : '—' }}</span>
              <span class="lr-text" :class="{ 'days-warn': daysLeft(f.deletedAt) <= 3 }">{{ daysLeft(f.deletedAt) }} 天</span>
              <span class="lr-text">{{ f.size }}</span>
              <span class="lr-actions">
                <Transition name="sel-cb">
                  <div v-if="inSelectionMode" class="sel-checkbox" :class="{ checked: selectedIds.has(f.id) }">
                    <svg v-if="selectedIds.has(f.id)" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M2 6l3 3 5-5"/>
                    </svg>
                  </div>
                </Transition>
                <template v-if="!inSelectionMode">
                  <button class="file-list-btn trash-restore-btn" title="恢复" @click.stop="restoreFile(f)">
                    <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M2 7A5 5 0 1 0 7 2"/><path d="M2 2v5h5"/>
                    </svg>
                    恢复
                  </button>
                  <button class="file-list-btn del" title="永久删除" @click.stop="hardDeleteFile(f)">
                    <PhTrash :size="11" weight="bold" />
                  </button>
                </template>
              </span>
            </div>
          </div>
          <FileBrowserEmptyState v-else-if="!loading" variant="trash" text="回收站为空" />
        </template>

        <!-- ── 网格视图 ── -->
        <template v-else-if="viewMode === 'grid'">
          <FileBrowserGrid @empty-context="openCtx('empty', null, $event)">

            <!-- 文件夹卡片 -->
            <FolderCard
              v-for="f in sortedContents.folders"
              :key="f.id"
              :display-name="f.displayName"
              :count-label="f.count != null ? f.count + ' 项' : '—'"
              :accent-color="folderAccentColor(f)"
              :selected="selectedFolderKeys.has(f.id)"
              :pre-selected="previewFolderKeys.has(f.id)"
              :drag-over="dragOverFolderId === f.folderId"
              :selection-mode="inSelectionMode"
              @contextmenu.prevent.stop="openCtx('folder', f, $event)"
              :data-folder-key="f.id"
              :data-folder-id="f.folderId"
              @click.stop="handleFolderClick(f, $event)"
              @pointerdown="onFolderPointerDown(f, $event)"
            >
              <template #icon>
                <component :is="folderListIcon(f)" class="fd-big-icon" :size="92" weight="bold" />
              </template>
              <template #name>
                <span :title="f.displayName">
                  <span v-if="renamingFolderKey === f.folderId" class="rename-sizer" @click.stop>
                    <span class="rename-ghost">{{ renameText || ' ' }}</span>
                    <input class="rename-input-inline" v-model="renameText"
                      v-enter="commitRename" @keydown.esc="cancelRename" @blur="commitRename" @focus="($event.target as HTMLInputElement).select()" />
                  </span>
                  <template v-else>{{ f.displayName }}</template>
                </span>
              </template>
              <template #actions>
                <button class="file-card-btn" :title="renamingFolderKey === f.folderId ? '确认' : '重命名'"
                  @mousedown.prevent @click.stop="renamingFolderKey === f.folderId ? commitRename() : startRenameFolder(f)">
                  <PhCheck v-if="renamingFolderKey === f.folderId" :size="11" weight="bold" />
                  <PhPencilSimple v-else :size="11" weight="bold" />
                </button>
                <button class="file-card-btn" title="下载为 ZIP" @click.stop="downloadFolder(f)">
                  <PhDownloadSimple :size="11" weight="bold" />
                </button>
                <button class="file-card-btn del" title="删除" @click.stop="deleteFolder(f)">
                  <PhTrash :size="11" weight="bold" />
                </button>
              </template>
            </FolderCard>

            <!-- 文件卡片：共用视觉抽到 components/common/FileCard.vue，这里只管文件库自己的
                 选择模式/拖拽/右键菜单等交互态（走 props 传给它统一画选中态），缩略图/重命名
                 输入框/悬浮操作这些本页专属内容走具名插槽。 -->
            <FileCard
              v-for="f in sortedContents.files"
              :key="f.id"
              class="hover-card-fx"
              :ext="f.ext" :display-name="f.displayName" :has-thumb="isImageExt(f.ext)"
              :selected="selectedIds.has(f.id)" :pre-selected="previewFileIds.has(f.id)"
              :dragging="draggingFileIds.has(f.id)" :cut="cbStore.type === 'cut' && cbStore.fileIds.includes(f.id)"
              :data-file-id="f.id"
              @contextmenu.prevent.stop="openCtx('file', f, $event)"
              @click.stop="handleFileClick(f, $event)"
              @pointerdown="onFilePointerDown(f, $event)"
            >
              <template #thumb>
                <!-- 模糊占位层：20×20 tiny，懒加载至视口附近再触发 -->
                <img class="fc-thumb-tiny" v-lazy-src="{ id: f.id, size: 'tiny' }"
                  decoding="async" draggable="false" alt="" />
                <!-- 全尺寸层：首次加载淡入，已加载过直接显示 -->
                <img class="fc-thumb-full" v-lazy-src="{ id: f.id, size: 'card' }"
                  :class="{ 'fc-loaded': cardBlobReadyIds.has(f.id) }"
                  decoding="async" draggable="false" alt=""
                  @load="cardBlobReadyIds.add(f.id)"
                  @error="($event.target as HTMLElement).style.display='none'" />
                <div class="fc-thumb-fade"></div>
              </template>
              <template #name>
                <span v-if="renamingFileId === f.id" class="rename-sizer" @click.stop>
                  <span class="rename-ghost">{{ renameText || ' ' }}</span>
                  <input class="rename-input-inline" v-model="renameText"
                    v-enter="commitRename" @keydown.esc="cancelRename" @blur="commitRename" @focus="($event.target as HTMLInputElement).select()" />
                </span>
                <template v-else>{{ f.displayName }}</template>
              </template>
              <template #meta>{{ f.size }} · {{ f.createdAt }}</template>

              <Transition name="sel-cb">
                <div v-if="inSelectionMode" class="sel-checkbox" :class="{ checked: selectedIds.has(f.id) }">
                  <svg v-if="selectedIds.has(f.id)" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M2 6l3 3 5-5"/>
                  </svg>
                </div>
              </Transition>
              <div v-if="!inSelectionMode" class="fc-hover-actions">
                <button class="file-card-btn" :title="renamingFileId === f.id ? '确认' : '重命名'"
                  @mousedown.prevent @click.stop="renamingFileId === f.id ? commitRename() : startRenameFile(f)">
                  <PhCheck v-if="renamingFileId === f.id" :size="11" weight="bold" />
                  <PhPencilSimple v-else :size="11" weight="bold" />
                </button>
                <button class="file-card-btn" title="下载" @click.stop="downloadFile(f)">
                  <PhDownloadSimple :size="11" weight="bold" />
                </button>
                <button class="file-card-btn del" title="移到回收站" @click.stop="deleteSingleFile(f)">
                  <PhTrash :size="11" weight="bold" />
                </button>
              </div>
            </FileCard>

            <!-- 幽灵上传卡：单文件 / 文件夹（拖入文件夹时汇总一张，不给里面每个文件各出一张） -->
            <FileUploadGhostCard v-for="g in uploadingItems" :key="g.uid"
              :name="g.name" :ext="g.ext" :is-folder="g.isFolder" :progress="g.progress"
              :done="g.done" :total="g.total" :failed="g.failed" :error="g.error" />
            <!-- 上传快捷区：跟项目文件区同一份共用组件 FileUploadButton.vue -->
            <FileUploadButton v-if="canUpload" mode="grid" @select="handleFileInput" />
          </FileBrowserGrid>

          <FileBrowserEmptyState v-if="contents.folders.length === 0 && contents.files.length === 0 && !loading && !canUpload" variant="grid" />
        </template>

        <!-- ── 列表视图 ── -->
        <template v-else>
          <FileBrowserList @empty-context="openCtx('empty', null, $event)">
            <div class="list-head">
              <span class="lh-sortable" :class="{ active: sortKey === 'name' }" @click="onSortSelect('name')">名称<svg class="lh-arrow" :class="{ desc: sortDir === 'desc' }" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 2v6M2 5l3-3 3 3"/></svg></span>
              <span class="lh-sortable" :class="{ active: sortKey === 'type' }" @click="onSortSelect('type')">类型<svg class="lh-arrow" :class="{ desc: sortDir === 'desc' }" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 2v6M2 5l3-3 3 3"/></svg></span>
              <span class="lh-sortable" :class="{ active: sortKey === 'stage' }" @click="onSortSelect('stage')">项目 / 阶段<svg class="lh-arrow" :class="{ desc: sortDir === 'desc' }" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 2v6M2 5l3-3 3 3"/></svg></span>
              <span class="lh-sortable" :class="{ active: sortKey === 'size' }" @click="onSortSelect('size')">大小<svg class="lh-arrow" :class="{ desc: sortDir === 'desc' }" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 2v6M2 5l3-3 3 3"/></svg></span>
              <span class="lh-sortable" :class="{ active: sortKey === 'createdAt' }" @click="onSortSelect('createdAt')">日期<svg class="lh-arrow" :class="{ desc: sortDir === 'desc' }" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 2v6M2 5l3-3 3 3"/></svg></span>
              <span></span>
            </div>

            <div
              v-for="f in sortedContents.folders"
              :key="f.id"
              class="list-row folder-row"
              :class="{ selected: selectedFolderKeys.has(f.id), 'pre-selected': previewFolderKeys.has(f.id), 'drag-over': dragOverFolderId === f.folderId }"
              :data-folder-key="f.id"
              :data-folder-id="f.folderId"
              @click.stop="handleFolderClick(f, $event)"
              @contextmenu.prevent.stop="openCtx('folder', f, $event)"
              @pointerdown="onFolderPointerDown(f, $event)"
            >
              <span class="lr-name-cell">
                <component :is="folderListIcon(f)" class="lr-folder-icon" :size="16" weight="fill" :style="{ color: folderAccentColor(f) }" />
                <span class="lr-filename" :title="f.displayName">
                  <span v-if="renamingFolderKey === f.folderId" class="rename-sizer" @click.stop>
                    <span class="rename-ghost">{{ renameText || ' ' }}</span>
                    <input class="rename-input-inline" v-model="renameText"
                      v-enter="commitRename" @keydown.esc="cancelRename" @blur="commitRename" @focus="($event.target as HTMLInputElement).select()" />
                  </span>
                  <template v-else>{{ f.displayName }}</template>
                </span>
              </span>
              <span class="lr-type-text">文件夹</span>
              <span class="lr-text">—</span>
              <span class="lr-text">{{ f.count != null ? f.count + ' 项' : '—' }}</span>
              <span class="lr-text">—</span>
              <span class="lr-actions">
                <Transition name="sel-cb">
                  <div v-if="inSelectionMode" class="sel-checkbox" :class="{ checked: selectedFolderKeys.has(f.id) }">
                    <svg v-if="selectedFolderKeys.has(f.id)" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M2 6l3 3 5-5"/>
                    </svg>
                  </div>
                </Transition>
                <template v-if="f.type === 'folder' && !inSelectionMode">
                  <button class="file-list-btn" :title="renamingFolderKey === f.folderId ? '确认' : '重命名'"
                    @mousedown.prevent @click.stop="renamingFolderKey === f.folderId ? commitRename() : startRenameFolder(f)">
                    <PhCheck v-if="renamingFolderKey === f.folderId" :size="11" weight="bold" />
                    <PhPencilSimple v-else :size="11" weight="bold" />
                  </button>
                  <button class="file-list-btn" title="下载为 ZIP" @click.stop="downloadFolder(f)">
                    <PhDownloadSimple :size="11" weight="bold" />
                  </button>
                  <button class="file-list-btn del" title="删除" @click.stop="deleteFolder(f)">
                    <PhTrash :size="11" weight="bold" />
                  </button>
                </template>
              </span>
            </div>

            <div
              v-for="f in sortedContents.files"
              :key="f.id"
              class="list-row"
              :class="{ selected: selectedIds.has(f.id), 'pre-selected': previewFileIds.has(f.id), dragging: draggingFileIds.has(f.id), cut: cbStore.type === 'cut' && cbStore.fileIds.includes(f.id) }"
              :data-file-id="f.id"
              @contextmenu.prevent.stop="openCtx('file', f, $event)"
              @click.stop="handleFileClick(f, $event)"
              @pointerdown="onFilePointerDown(f, $event)"
            >
              <span class="lr-name-cell">
                <component :is="fileListIcon(f.ext)" class="lr-file-icon" :size="16" weight="fill" :style="{ color: fileIconColor(f.ext) }" />
                <span class="lr-filename" :title="f.displayName">
                  <span v-if="renamingFileId === f.id" class="rename-sizer" @click.stop>
                    <span class="rename-ghost">{{ renameText || ' ' }}</span>
                    <input class="rename-input-inline" v-model="renameText"
                      v-enter="commitRename" @keydown.esc="cancelRename" @blur="commitRename" @focus="($event.target as HTMLInputElement).select()" />
                  </span>
                  <template v-else>{{ f.displayName }}</template>
                </span>
              </span>
              <span class="lr-type-cell">
                <span class="lr-ext" :style="{ color: fileIconColor(f.ext), background: fileIconColor(f.ext) + '18' }">{{ f.ext }}</span>
              </span>
              <span class="lr-proj-cell">
                <span v-if="f.projectColor" class="lr-dot" :style="{ background: f.projectColor }"></span>
                <span class="lr-projname">{{ f.projectName || f.stageName || '—' }}</span>
              </span>
              <span class="lr-text">{{ f.size }}</span>
              <span class="lr-text">{{ f.createdAt }}</span>
              <span class="lr-actions">
                <Transition name="sel-cb">
                  <div v-if="inSelectionMode" class="sel-checkbox" :class="{ checked: selectedIds.has(f.id) }">
                    <svg v-if="selectedIds.has(f.id)" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M2 6l3 3 5-5"/>
                    </svg>
                  </div>
                </Transition>
                <template v-if="!inSelectionMode">
                  <button class="file-list-btn" :title="renamingFileId === f.id ? '确认' : '重命名'"
                    @mousedown.prevent @click.stop="renamingFileId === f.id ? commitRename() : startRenameFile(f)">
                    <PhCheck v-if="renamingFileId === f.id" :size="11" weight="bold" />
                    <PhPencilSimple v-else :size="11" weight="bold" />
                  </button>
                  <button class="file-list-btn" title="下载" @click.stop="downloadFile(f)">
                    <PhDownloadSimple :size="11" weight="bold" />
                  </button>
                  <button class="file-list-btn del" title="移到回收站" @click.stop="deleteSingleFile(f)">
                    <PhTrash :size="11" weight="bold" />
                  </button>
                </template>
              </span>
            </div>

            <!-- 幽灵上传行：单文件 / 文件夹（拖入文件夹时汇总一行） -->
            <FileUploadGhostCard v-for="g in uploadingItems" :key="g.uid" mode="list"
              :name="g.name" :ext="g.ext" :is-folder="g.isFolder" :progress="g.progress"
              :done="g.done" :total="g.total" :failed="g.failed" :error="g.error">
              <template #list="{ color, statusText }">
              <span class="lr-name-cell">
                <PhFolder v-if="g.isFolder" class="lr-file-icon" :size="16" weight="fill" :style="{ color }" />
                <component v-else :is="fileListIcon(g.ext)" class="lr-file-icon" :size="16" weight="fill" :style="{ color }" />
                <span class="lr-filename">{{ g.name }}</span>
              </span>
              <span class="lr-type-cell">
                <span v-if="!g.isFolder" class="lr-ext" :style="{ color: fileIconColor(g.ext), background: fileIconColor(g.ext) + '18' }">{{ g.ext || '—' }}</span>
              </span>
              <span class="lr-text">—</span>
              <span class="lr-text">—</span>
              <span class="lr-text">
                {{ statusText }}
              </span>
              <span class="lr-actions"></span>
              </template>
            </FileUploadGhostCard>

            <FileBrowserEmptyState v-if="contents.folders.length === 0 && contents.files.length === 0 && !loading" variant="list" />

            <!-- 上传行：网格视图一直有这个入口，列表视图之前漏画了 -->
            <FileUploadButton v-if="canUpload" mode="list" @select="handleFileInput" />
          </FileBrowserList>
        </template>

        </div>
        </Transition>
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
import { ref, computed, watch, reactive, onMounted, onUnmounted, nextTick } from 'vue'
import { filesApi, type TrashFolderMeta } from '@/services/api'
import FileCard       from '@/components/common/file-browser/FileCard.vue'
import FolderCard     from '@/components/common/file-browser/FolderCard.vue'
import FileUploadGhostCard from '@/components/common/file-browser/FileUploadGhostCard.vue'
import FileUploadButton from '@/components/common/file-browser/FileUploadButton.vue'
import FileUploadDropOverlay from '@/components/common/file-browser/FileUploadDropOverlay.vue'
import FileBrowserEmptyState from '@/components/common/file-browser/FileBrowserEmptyState.vue'
import FileStorageUsage from '@/components/common/file-browser/FileStorageUsage.vue'
import FileTrashToolbarActions from '@/components/common/file-browser/FileTrashToolbarActions.vue'
import FileBrowserGrid from '@/components/common/file-browser/FileBrowserGrid.vue'
import FileBrowserBreadcrumb from '@/components/common/file-browser/FileBrowserBreadcrumb.vue'
import FileBrowserPanel from '@/components/common/file-browser/FileBrowserPanel.vue'
import FileBrowserContextMenu from '@/components/common/file-browser/FileBrowserContextMenu.vue'
import FileBrowserContextMenuContent from '@/components/common/file-browser/FileBrowserContextMenuContent.vue'
import FileBrowserList from '@/components/common/file-browser/FileBrowserList.vue'
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
import { useSorting } from '@/composables/useSorting'
import UploadConflictDialog from '@/components/common/UploadConflictDialog.vue'
import {
  PhFolder, PhUser, PhStack, PhTrash, PhCalendarBlank, PhCalendarDot,
  PhClock, PhPlayCircle, PhCheckCircle,
  PhBrowser,
  PhArrowLeft, PhArrowRight,
  PhCheck, PhPencilSimple,
  PhDownloadSimple,
  PhWarningCircle,
} from '@phosphor-icons/vue'

const projectStore = useProjectStore()
const cacheStore   = useFilesCacheStore()
const uiStore      = useUiStore()
const cbStore      = useClipboardStore()

// ── 存储用量 ──
const storageInfo = reactive({ used: 0, limit: null, loaded: false })
async function fetchStorage() {
  try {
    const data = await filesApi.storage()
    storageInfo.used   = data.used_bytes  ?? 0
    storageInfo.limit  = data.limit_bytes ?? null
    storageInfo.loaded = true
  } catch {}
}

// ── 视图状态 ──
// 使用模块级 cardBlobReadyIds：首次 @load 后写入，session 内二次访问直接显示跳过动画
const viewMode    = ref<'grid' | 'list'>('grid')
const loading     = ref(false)
const mainRef     = ref<HTMLElement | null>(null)
let directoryLoader: () => void = () => {}
function loadContents() { directoryLoader() }
// 状态文件夹的色 / 图标（待开始灰 / 进行中蓝 / 已完成绿）
const STATUS_COLOR: Record<string, string> = { pending: '#8a8fa8', active: '#5080c8', done: '#4a9a72' }
const STATUS_ICON: Record<string, typeof PhClock> = { pending: PhClock, active: PhPlayCircle, done: PhCheckCircle }

// ── 导航 ──
const {
  navPath, canGoBack, canGoForward, goBack, goForward,
  currentType, currentSeg, projectSeg, canUpload,
  saveNav, enterFolder, navigateTo, restoreNav, pruneHistoryForFolders,
} = useFilesNav({ loadContents, clearSelection })

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

function toggleFileSelect(fileId: number, e: MouseEvent) {
  if (e.ctrlKey || e.metaKey) selection.handleFileClick(sortedContents.value.files.find(file => file.id === fileId)!, e)
  else selection.handleFileClick(sortedContents.value.files.find(file => file.id === fileId)!, e)
}

function onPageClick() {
  clearSelection()
  // 排序菜单由 SortMenu 内部的 ContextMenu 监听外部 click 自动关闭，这里不用手动处理
}

// ── 删除 ──
async function deleteSingleFile(f: FileMeta) {
  const backup = cacheStore.getFile(f.id)
  await optimisticMutation({
    apply: () => {
      cacheStore.removeFile(f.id)
      selectedIds.value = new Set([...selectedIds.value].filter(id => id !== f.id))
    },
    afterMutate: loadContents,
    work: () => fileActions.deleteFile(f.id),
    onCommit: fetchStorage,
    rollback: () => { if (backup) cacheStore.addFile(backup) },
    onError: e => console.error('[Files] 删除失败:', (e as Error).message),
  })
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

// ── 新建文件夹 ──
const newFolderName      = ref('')
const newFolderLoading   = ref(false)
const showNewFolderInput = ref(false)

async function createFolder() {
  const name = newFolderName.value.trim()
  if (!name) return
  const type      = currentType.value
  const seg       = currentSeg.value
  const projectId = (type === 'project' || type === 'folder')
    ? (projectSeg.value?.id ?? seg?.projectId ?? null)
    : null
  const parentId  = type === 'folder' ? (seg?.folderId ?? null) : null
  newFolderLoading.value = true
  const tempId = -(Date.now())
  cacheStore.addFolder({ id: tempId, name, projectId, parentId, fileCount: 0 })
  newFolderName.value = ''
  showNewFolderInput.value = false
  loadContents()
  try {
    const real = await fileActions.createFolder(projectId, name, parentId)
    cacheStore.removeFolder(tempId)
    cacheStore.addFolder({ id: real.id, name: real.name, projectId: real.projectId ?? null, parentId: real.parentId ?? null, fileCount: 0 })
    loadContents()
  } catch (e) {
    cacheStore.removeFolder(tempId)
    loadContents()
    console.error('[Files] 新建文件夹失败:', (e as Error).message)
  } finally {
    newFolderLoading.value = false
  }
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
const fileActions = useFileActions()
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

function downloadSelected() {
  return batchActions.downloadSelected()
}

function deleteSelected() {
  return batchActions.deleteSelected()
}

// ── 下载 ──
async function downloadFile(f: FileMeta) {
  try {
    await fileActions.downloadFile(f)
  } catch (e) {
    console.error('[Files] 下载失败:', (e as Error).message)
  }
}

// ── 重命名 ──
const renamingFileId    = ref<number | null>(null)
const renamingFolderKey = ref<number | null>(null)
const renameText        = ref('')

function startRenameFile(f: FileMeta) {
  renamingFolderKey.value = null
  renamingFileId.value    = f.id
  renameText.value        = f.displayName
  nextTick(() => document.querySelector<HTMLInputElement>('.rename-input-inline')?.select())
}

function startRenameFolder(f: FolderCardMeta) {
  renamingFileId.value    = null
  renamingFolderKey.value = f.folderId ?? null
  renameText.value        = f.displayName
  nextTick(() => document.querySelector<HTMLInputElement>('.rename-input-inline')?.select())
}

function cancelRename() {
  renamingFileId.value    = null
  renamingFolderKey.value = null
  renameText.value        = ''
}

async function commitRename() {
  const fileId    = renamingFileId.value
  const folderId  = renamingFolderKey.value
  if (fileId == null && folderId == null) return
  const name = renameText.value.trim()
  cancelRename()
  if (!name) return
  if (fileId != null) {
    const oldName = cacheStore.getFile(fileId)?.displayName
    cacheStore.updateFile(fileId, { displayName: name })
    loadContents()
    fileActions.renameFile(fileId, name).catch(e => {
      if (oldName != null) cacheStore.updateFile(fileId, { displayName: oldName })
      loadContents()
      console.error('[Files] 重命名失败:', (e as Error).message)
    })
  } else {
    if (folderId == null) return
    const oldFolder = cacheStore.getFolder(folderId)
    const oldName = oldFolder?.name
    const version = oldFolder?.version ?? 1
    cacheStore.updateFolder(folderId, { name })
    loadContents()
    fileActions.renameFolder(folderId, name, version).then(updated => {
      cacheStore.updateFolder(folderId, { version: updated.version })
    }).catch(e => {
      if (oldName != null) cacheStore.updateFolder(folderId, { name: oldName })
      loadContents()   // 409（版本冲突）时顺带把最新状态/version 拉回来
      console.error('[Files] 重命名失败:', (e as Error).message)
    })
  }
}

async function downloadFolder(f: FolderCardMeta) {
  if (f.folderId == null) return
  try {
    await fileActions.downloadFolder(f)
  } catch (e) {
    console.error('[Files] 下载文件夹失败:', (e as Error).message)
  }
}

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
    const seg = navPath.value[idx]
    if (!seg || !isBcDroppable(seg)) return null
    return { targetFolderId: seg.type === 'folder' ? (seg.folderId ?? null) : null, acceptsFiles: true, acceptsFolders: true }
  },
  cancelBoxDrag: () => _cancelBoxDrag(),
  clearSelection() { selectedFolderKeys.value = new Set(); selectedIds.value = new Set() },
  moveFolders: moveFoldersInto,
  moveFiles: moveFilesInto,
})

// selectedFolderKeys 里放的是 f.id（"f:65"），拖拽需要真实数字 folderId——查当前层文件夹列表换算
function _selectedFolderIdNums() {
  return new Set(resolveFolderIds(selectedFolderKeys.value, sortedContents.value.folders))
}

function onFolderPointerDown(f: FolderCardMeta, e: PointerEvent) {
  // 全部文件根目录下"个人文件/项目文件/回收站"是伪文件夹卡片（type 不是 'folder'，没有真实
  // folderId），不能拖拽——之前没挡，f.folderId 是 undefined，落点判定/吸入动画照样能触发
  // （只是数据层最终 API 调用会因 id 无效而静默失败），表现为"能拖进别的卡片，但只有动画有效果"。
  if (f.type !== 'folder' || f.folderId == null) return
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
  _onFilePointerDown(e, {
    itemId: f.id,
    isSelected: selectedIds.value.has(f.id),
    selectedFileIds: selectedIds.value,
    selectedFolderIds: _selectedFolderIdNums(),
    extraOpts: { dragZIndex: 31 },
  })
}

async function deleteFolder(f: FolderCardMeta) {
  if (f.folderId == null) return
  pruneHistoryForFolders([f.folderId])
  cacheStore.removeFolder(f.folderId)
  loadContents()
  try {
    await fileActions.deleteFolder(f.folderId)
    fetchStorage()
  } catch (e) {
    // 无法回滚（不知道子结构），静默刷新
    cacheStore.refresh().then(() => loadContents())
    console.error('[Files] 删除文件夹失败:', (e as Error).message)
  }
}

// ── 样式工具 ──
function folderIconStyle(folder: FolderCardMeta) {
  if (folder.type === 'personal') return { background: 'rgba(180,148,80,0.14)',  color: '#b49450' }
  if (folder.type === 'projects') return { background: 'rgba(123,127,178,0.13)', color: '#7b7fb2' }
  if (folder.type === 'trash')    return { background: 'rgba(220,80,80,0.1)',    color: '#c85a5a' }
  if (folder.type === 'status')   { const c = STATUS_COLOR[folder.status ?? ''] || '#7b7fb2'; return { background: c + '1f', color: c } }
  if (folder.type === 'year')     return { background: 'rgba(80,160,120,0.12)',  color: '#4a9a72' }
  if (folder.type === 'month')    return { background: 'rgba(80,130,200,0.11)',  color: '#5080c8' }
  if (folder.color) {
    const c = folder.color
    return { background: `${c}22`, color: c }
  }
  return { background: 'rgba(123,127,178,0.1)', color: 'var(--color-primary)' }
}

// 文件类型助手（isImageExt / fileExtCategory / fileIconColor / fileListIcon）与缩略图懒加载指令
// vLazySrc 已统一收口到 @/utils/fileTypes 和 @/composables/useLazyThumb，见顶部 import。

function folderListIcon(folder: FolderCardMeta) {
  if (folder.type === 'personal') return PhUser
  if (folder.type === 'projects') return PhStack
  if (folder.type === 'trash')    return PhTrash
  if (folder.type === 'status')   return STATUS_ICON[folder.status ?? ''] || PhStack
  if (folder.type === 'year')     return PhCalendarBlank
  if (folder.type === 'month')    return PhCalendarDot
  if (folder.type === 'project')  return PhBrowser
  return PhFolder
}

function folderAccentColor(folder: FolderCardMeta) {
  if (folder.type === 'personal') return '#967858'
  if (folder.type === 'projects') return '#6878a8'
  if (folder.type === 'trash')    return '#987070'
  if (folder.type === 'status')   return STATUS_COLOR[folder.status ?? ''] || '#8888a8'
  if (folder.type === 'year')     return '#508878'
  if (folder.type === 'month')    return '#5878a8'
  if (folder.color) return folder.color
  return '#8888a8'
}

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
.content-fade-enter-active { transition: opacity 0.12s ease; }
.content-fade-leave-active { transition: opacity 0.04s ease; }
.content-fade-enter-from, .content-fade-leave-to { opacity: 0; }
</style>
