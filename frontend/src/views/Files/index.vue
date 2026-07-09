<template>
  <div class="files-page" @click="onPageClick">

    <!-- 工具栏 -->
    <div class="files-toolbar glass-card" @click.stop>

      <!-- 面包屑导航 -->
      <div class="breadcrumb">
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
      </div>

      <div class="toolbar-right">
        <!-- 粘贴（剪切/复制后出现，回收站除外）—— 放在所有按钮最左 -->
        <button
          v-if="cbStore.hasContent() && currentType !== 'trash' && currentType !== 'root'"
          class="paste-btn"
          @click="ctxPaste"
          title="粘贴到当前位置"
        >
          <PhClipboardText :size="13" weight="bold" />
          粘贴{{ (cbStore.fileIds.length + cbStore.folderIds.length) > 1 ? ` (${cbStore.fileIds.length + cbStore.folderIds.length})` : '' }}
        </button>

        <!-- 多选（根目录不需要） -->
        <button
          v-if="currentType !== 'root'"
          class="select-mode-btn"
          :class="{ on: inSelectionMode }"
          @click="toggleSelectMode"
          title="选择"
        >
          <PhCheckSquare :size="13" weight="bold" />
        </button>

        <!-- 全选（仅回收站，放在多选按钮右侧） -->
        <button
          v-if="currentType === 'trash' && contents.files.length"
          class="select-all-btn"
          :class="{ on: allTrashSelected }"
          @click="toggleSelectAllTrash"
          :title="allTrashSelected ? '取消全选' : '全选'"
        >
          {{ allTrashSelected ? '取消全选' : '全选' }}
        </button>

        <!-- 网格/列表切换 -->
        <div v-if="currentType !== 'trash'" class="view-toggle">
          <button :class="{ on: viewMode === 'grid' }" @click="viewMode = 'grid'" title="网格视图">
            <PhSquaresFour :size="13" weight="bold" />
          </button>
          <button :class="{ on: viewMode === 'list' }" @click="viewMode = 'list'" title="列表视图">
            <PhList :size="13" weight="bold" />
          </button>
        </div>

        <!-- 新建文件夹（个人层、项目层、文件夹层） -->
        <template v-if="currentType === 'personal' || currentType === 'project' || currentType === 'folder'">
          <div v-if="showNewFolderInput" class="new-folder-row" @click.stop>
            <input
              class="new-folder-input"
              v-model="newFolderName"
              placeholder="文件夹名称"
              v-enter="createFolder"
              @keyup.esc="showNewFolderInput = false; newFolderName = ''"
              ref="folderInputRef"
            />
            <button class="btn-confirm" :disabled="newFolderLoading" @click="createFolder">确定</button>
            <button class="btn-cancel" @click="showNewFolderInput = false; newFolderName = ''">✕</button>
          </div>
          <button v-else class="new-folder-btn" @click.stop="showNewFolderInput = true">
            <PhFolderPlus :size="13" weight="bold" />
            新建文件夹
          </button>
        </template>

        <!-- 排序选择器 -->
        <div v-if="currentType !== 'root'" class="sort-selector" @click.stop>
          <button ref="sortBtnRef" class="sort-btn" @click.stop="openSortMenu">
            <PhSortAscending :size="13" weight="bold" />
            {{ SORT_OPTIONS.find(o => o.key === sortKey)?.label }}
            <svg class="sort-dir-icon" :class="{ desc: sortDir === 'desc' }" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
              <path d="M5 2v6M2 5l3-3 3 3"/>
            </svg>
          </button>
          <!-- 与右键菜单同源：Teleport 到 body，backdrop-filter 才能正确生效 -->
          <ContextMenu :show="sortMenuOpen" :x="sortMenuPos.x" :y="sortMenuPos.y" @close="sortMenuOpen = false">
            <button v-for="opt in SORT_OPTIONS" :key="opt.key"
              class="ctx-item popup-menu-item sort-menu-item" :class="{ active: sortKey === opt.key }"
              @click="onSortSelect(opt.key)">
              {{ opt.label }}
              <svg v-if="sortKey === opt.key" class="sort-check" :class="{ desc: sortDir === 'desc' }" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                <path d="M5 2v6M2 5l3-3 3 3"/>
              </svg>
            </button>
          </ContextMenu>
        </div>

        <!-- 清空回收站 -->
        <button v-if="currentType === 'trash'" class="empty-trash-btn" @click.stop="confirmEmptyTrash">
          <PhTrash :size="12" weight="bold" />
          清空回收站
        </button>

        <!-- 存储用量 -->
        <div v-if="storageInfo.loaded" class="storage-pill" :class="{ 'no-limit': storageInfo.limit === null }"
          :title="storageInfo.limit ? `已用 ${fmtBytes(storageInfo.used)} / ${fmtBytes(storageInfo.limit)}` : `已用 ${fmtBytes(storageInfo.used)}`">
          <template v-if="storageInfo.limit !== null">
            <div class="storage-bar-bg">
              <div class="storage-bar-fill" :style="storageFillStyle"></div>
            </div>
          </template>
          <span class="storage-text">
            {{ fmtBytes(storageInfo.used) }}
            <template v-if="storageInfo.limit !== null"> / {{ fmtBytes(storageInfo.limit) }}</template>
          </span>
        </div>

      </div>
    </div>

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
        <Transition name="drop-fade">
          <div v-if="isDragging" class="drop-overlay" @dragover.prevent @drop.prevent="handleDrop" @dragleave.stop>
            <div class="drop-zone-hint">
              <svg width="36" height="36" viewBox="0 0 44 44" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 30V16M15 22l7-7 7 7"/><path d="M8 36h28"/>
              </svg>
              <span class="drop-hint">松开以上传文件</span>
            </div>
          </div>
        </Transition>

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
          <div v-if="contents.files.length > 0" class="file-list trash-list">
            <div class="list-head">
              <span class="lh-sortable" :class="{ active: sortKey === 'name' }" @click="onSortSelect('name')">名称<svg class="lh-arrow" :class="{ desc: sortDir === 'desc' }" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 2v6M2 5l3-3 3 3"/></svg></span>
              <span>类型</span>
              <span class="lh-sortable" :class="{ active: sortKey === 'createdAt' }" @click="onSortSelect('createdAt')">删除时间<svg class="lh-arrow" :class="{ desc: sortDir === 'desc' }" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 2v6M2 5l3-3 3 3"/></svg></span>
              <span>剩余</span>
              <span class="lh-sortable" :class="{ active: sortKey === 'size' }" @click="onSortSelect('size')">大小<svg class="lh-arrow" :class="{ desc: sortDir === 'desc' }" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 2v6M2 5l3-3 3 3"/></svg></span>
              <span></span>
            </div>
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
          <div v-else-if="!loading" class="grid-empty">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="0.3">
              <path d="M5 8h22M10 8V6h12v2M13 13v7M19 13v7M6 8l1.5 15a2 2 0 002 1.8h13a2 2 0 002-1.8L26 8"/>
            </svg>
            回收站为空
          </div>
        </template>

        <!-- ── 网格视图 ── -->
        <template v-else-if="viewMode === 'grid'">
          <div class="file-grid" @contextmenu.prevent.self="openCtx('empty', null, $event)">

            <!-- 文件夹卡片 -->
            <div
              v-for="f in sortedContents.folders"
              :key="f.id"
              class="folder-card"
              :class="{ selected: selectedFolderKeys.has(f.id), 'pre-selected': previewFolderKeys.has(f.id), 'drag-over': dragOverFolderId === f.folderId }"
              @contextmenu.prevent.stop="openCtx('folder', f, $event)"
              :data-folder-key="f.id"
              :data-folder-id="f.folderId"
              :style="{ '--fd-color': folderAccentColor(f) }"
              @click.stop="handleFolderClick(f, $event)"
              @pointerdown="onFolderPointerDown(f, $event)"
            >
              <div class="fd-icon-area">
                <component :is="folderListIcon(f)" class="fd-big-icon" :size="92" weight="bold" />
              </div>
              <div class="fd-label">
                <div class="fd-name" :title="f.displayName">
                  <span v-if="renamingFolderKey === f.folderId" class="rename-sizer" @click.stop>
                    <span class="rename-ghost">{{ renameText || ' ' }}</span>
                    <input class="rename-input-inline" v-model="renameText"
                      v-enter="commitRename" @keydown.esc="cancelRename" @blur="commitRename" @focus="($event.target as HTMLInputElement).select()" />
                  </span>
                  <template v-else>{{ f.displayName }}</template>
                </div>
                <div class="fd-count">{{ f.count != null ? f.count + ' 项' : '—' }}</div>
              </div>
              <Transition name="sel-cb">
                <div v-if="inSelectionMode" class="sel-checkbox" :class="{ checked: selectedFolderKeys.has(f.id) }">
                  <svg v-if="selectedFolderKeys.has(f.id)" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M2 6l3 3 5-5"/>
                  </svg>
                </div>
              </Transition>
              <div v-if="f.type === 'folder' && !inSelectionMode" class="fd-hover-actions">
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
              </div>
            </div>

            <!-- 文件卡片 -->
            <div
              v-for="f in sortedContents.files"
              :key="f.id"
              class="fc-card hover-card-fx"
              :class="{ selected: selectedIds.has(f.id), 'pre-selected': previewFileIds.has(f.id), dragging: draggingFileIds.has(f.id), cut: cbStore.type === 'cut' && cbStore.fileIds.includes(f.id), 'fc-has-thumb': isImageExt(f.ext) }"
              :data-file-id="f.id"
              :style="{ '--fc-color': fileIconColor(f.ext) }"
              @contextmenu.prevent.stop="openCtx('file', f, $event)"
              @click.stop="handleFileClick(f, $event)"
              @pointerdown="onFilePointerDown(f, $event)"
            >
              <span class="fc-ext-badge">{{ f.ext }}</span>
              <div v-if="isImageExt(f.ext)" class="fc-thumb-area">
                <!-- 模糊占位层：20×20 tiny，懒加载至视口附近再触发 -->
                <img class="fc-thumb fc-thumb-tiny" v-lazy-src="{ id: f.id, size: 'tiny' }"
                  decoding="async" draggable="false" alt="" />
                <!-- 全尺寸层：首次加载淡入，已加载过直接显示 -->
                <img class="fc-thumb fc-thumb-full" v-lazy-src="{ id: f.id, size: 'card' }"
                  :class="{ 'fc-loaded': cardBlobReadyIds.has(f.id) }"
                  decoding="async" draggable="false" alt=""
                  @load="cardBlobReadyIds.add(f.id)"
                  @error="($event.target as HTMLElement).style.display='none'" />
                <div class="fc-thumb-fade"></div>
              </div>
              <div v-else class="fc-icon-area">
                <component :is="fileListIcon(f.ext)" class="fc-big-icon" :size="86" weight="bold" />
              </div>
              <div class="fc-label">
                <div class="fc-name" :title="f.displayName">
                  <span v-if="renamingFileId === f.id" class="rename-sizer" @click.stop>
                    <span class="rename-ghost">{{ renameText || ' ' }}</span>
                    <input class="rename-input-inline" v-model="renameText"
                      v-enter="commitRename" @keydown.esc="cancelRename" @blur="commitRename" @focus="($event.target as HTMLInputElement).select()" />
                  </span>
                  <template v-else>{{ f.displayName }}</template>
                </div>
                <div class="fc-meta">{{ f.size }} · {{ f.createdAt }}</div>
              </div>
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
            </div>

            <!-- 幽灵上传卡：单文件 / 文件夹（拖入文件夹时汇总一张，不给里面每个文件各出一张） -->
            <div v-for="g in uploadingItems" :key="g.uid"
              class="fc-ghost" :class="{ error: g.error, 'fc-ghost-folder': g.isFolder }"
              :style="{ '--fc-color': g.isFolder ? '#8a8fa8' : fileIconColor(g.ext) }">
              <div class="fc-ghost-fill" :style="{ width: g.progress + '%' }"></div>
              <span v-if="!g.isFolder" class="fc-ext-badge">{{ g.ext || '—' }}</span>
              <div class="fc-icon-area">
                <PhFolder v-if="g.isFolder" class="fc-big-icon" :size="86" weight="bold" />
                <component v-else :is="fileListIcon(g.ext)" class="fc-big-icon" :size="86" weight="bold" />
              </div>
              <div class="fc-label">
                <div class="fc-name" :title="g.name">{{ g.name }}</div>
                <div class="fc-meta fc-ghost-meta">
                  <template v-if="g.isFolder">
                    <template v-if="g.error">{{ g.done - g.failed }}/{{ g.total }}（{{ g.failed }} 个失败）</template>
                    <template v-else>{{ g.done }}/{{ g.total }}</template>
                  </template>
                  <template v-else-if="g.error">上传失败</template>
                  <template v-else>{{ g.progress }}%</template>
                </div>
              </div>
            </div>
            <!-- 上传快捷区 -->
            <label v-if="canUpload" class="fc-upload">
              <svg width="20" height="20" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.4">
                <path d="M11 15V5M6 9l5-5 5 5"/><path d="M2 17h18"/>
              </svg>
              <span class="fc-upload-text">上传文件</span>
              <input type="file" hidden multiple @change="handleFileInput" />
            </label>
          </div>

          <div v-if="contents.folders.length === 0 && contents.files.length === 0 && !loading && !canUpload" class="grid-empty">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="0.3">
              <path d="M4 9a2 2 0 012-2h5l2 2h10a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V9z"/>
            </svg>
            暂无文件
          </div>
        </template>

        <!-- ── 列表视图 ── -->
        <template v-else>
          <div class="file-list" @contextmenu.prevent.self="openCtx('empty', null, $event)">
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
            <div v-for="g in uploadingItems" :key="g.uid"
              class="list-row fc-ghost-row" :class="{ error: g.error }">
              <div class="fc-ghost-fill" :style="{ width: g.progress + '%' }"></div>
              <span class="lr-name-cell">
                <PhFolder v-if="g.isFolder" class="lr-file-icon" :size="16" weight="fill" style="color:#8a8fa8" />
                <component v-else :is="fileListIcon(g.ext)" class="lr-file-icon" :size="16" weight="fill" :style="{ color: fileIconColor(g.ext) }" />
                <span class="lr-filename">{{ g.name }}</span>
              </span>
              <span class="lr-type-cell">
                <span v-if="!g.isFolder" class="lr-ext" :style="{ color: fileIconColor(g.ext), background: fileIconColor(g.ext) + '18' }">{{ g.ext || '—' }}</span>
              </span>
              <span class="lr-text">—</span>
              <span class="lr-text">—</span>
              <span class="lr-text">
                <template v-if="g.isFolder">{{ g.done }}/{{ g.total }}<template v-if="g.error">（{{ g.failed }} 失败）</template></template>
                <template v-else-if="g.error">失败</template>
                <template v-else>{{ g.progress }}%</template>
              </span>
              <span class="lr-actions"></span>
            </div>

            <div v-if="contents.folders.length === 0 && contents.files.length === 0 && !loading" class="list-empty">
              <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity="0.3">
                <path d="M4 8a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V8z"/>
              </svg>
              暂无文件
            </div>
          </div>
        </template>

        </div>
        </Transition>
      </div>
    </div>

    <!-- 批量操作浮动栏 -->
    <Transition name="action-bar">
      <div v-if="selectedIds.size > 0 || selectedFolderKeys.size > 0" class="selection-bar" @click.stop>
        <span class="sel-count">已选 {{ selectedIds.size + selectedFolderKeys.size }} 项</span>
        <template v-if="currentType === 'trash'">
          <button class="sel-download-btn" @click="restoreSelected">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2 7A5 5 0 1 0 7 2"/><path d="M2 2v5h5"/>
            </svg>
            恢复选中
          </button>
          <button class="sel-delete-btn" @click="hardDeleteSelected">
            <PhTrash :size="12" weight="bold" />
            永久删除
          </button>
        </template>
        <template v-else>
          <button class="sel-download-btn" @click="downloadSelected" :disabled="(selectedIds.size === 0 && selectedFolderKeys.size === 0) || downloadingZip">
            <PhDownloadSimple v-if="!downloadingZip" :size="12" weight="bold" />
            <svg v-else class="spin" width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
              <path d="M7 1a6 6 0 1 1-4.24 1.76"/>
            </svg>
            {{ downloadingZip ? '下载中…' : '下载' }}
          </button>
          <div class="sel-divider"></div>
          <button class="sel-action-btn" @click="selCut" title="剪切">
            <PhScissors :size="12" weight="bold" />
            剪切
          </button>
          <button class="sel-action-btn" @click="selCopy" title="复制">
            <PhCopy :size="12" weight="bold" />
            复制
          </button>
          <div class="sel-divider"></div>
          <button class="sel-delete-btn" @click="deleteSelected">
            <PhTrash :size="12" weight="bold" />
            移到回收站
          </button>
        </template>
        <button class="sel-cancel-btn" @click="clearSelection">取消</button>
      </div>
    </Transition>

  </div>

  <!-- 右键菜单 -->
  <ContextMenu :show="ctx.visible" :x="ctx.x" :y="ctx.y" @close="ctx.visible = false">
    <!-- 文件菜单 -->
    <template v-if="ctx.type === 'file' || ctx.type === 'multi-file'">
      <button v-if="ctx.type === 'file'" class="ctx-item popup-menu-item" @click="ctxInfo">
        <PhInfo :size="13" weight="bold" />
        详细信息
      </button>
      <button class="ctx-item popup-menu-item" @click="ctxDownload">
        <PhDownloadSimple :size="13" weight="bold" />
        下载
      </button>
      <button v-if="ctx.type === 'file'" class="ctx-item popup-menu-item" @click="ctxRename">
        <PhPencilSimple :size="13" weight="bold" />
        重命名
      </button>
      <div class="popup-menu-sep"></div>
      <button class="ctx-item popup-menu-item" @click="ctxCut">
        <PhScissors :size="13" weight="bold" />
        剪切
        <span class="popup-menu-shortcut">{{ modKey }}+X</span>
      </button>
      <button class="ctx-item popup-menu-item" @click="ctxCopy">
        <PhCopy :size="13" weight="bold" />
        复制
        <span class="popup-menu-shortcut">{{ modKey }}+C</span>
      </button>
      <div class="popup-menu-sep"></div>
      <button class="ctx-item popup-menu-item danger" @click="ctxDelete">
        <PhTrash :size="13" weight="bold" />
        移到回收站
      </button>
    </template>

    <!-- 文件夹菜单 -->
    <template v-else-if="ctx.type === 'folder'">
      <button v-if="ctx.target?.type === 'folder'" class="ctx-item popup-menu-item" @click="ctxDownloadFolder">
        <PhDownloadSimple :size="13" weight="bold" />
        下载为 ZIP
      </button>
      <button v-if="ctx.target?.type === 'folder'" class="ctx-item popup-menu-item" @click="ctxRenameFolder">
        <PhPencilSimple :size="13" weight="bold" />
        重命名
      </button>
      <button v-if="ctx.target?.type === 'folder'" class="ctx-item popup-menu-item" @click="ctxCutFolder">
        <PhScissors :size="13" weight="bold" />
        剪切
        <span class="popup-menu-shortcut">{{ modKey }}+X</span>
      </button>
      <button v-if="ctx.target?.type === 'folder'" class="ctx-item popup-menu-item danger" @click="ctxDeleteFolder">
        <PhTrash :size="13" weight="bold" />
        删除
      </button>
      <button v-if="ctx.target?.type !== 'folder'" class="ctx-item popup-menu-item" disabled style="opacity:.4;cursor:default">
        <PhDotsThree :size="13" weight="bold" />
        此位置不可操作
      </button>
    </template>

    <!-- 空白区菜单 -->
    <template v-else-if="ctx.type === 'empty'">
      <button class="ctx-item popup-menu-item" @click="ctx.visible = false; showNewFolderInput = true">
        <PhFolderPlus :size="13" weight="bold" />
        新建文件夹
      </button>
      <div class="popup-menu-sep"></div>
      <button v-if="cbStore.hasContent()" class="ctx-item popup-menu-item" @click="ctxPaste">
        <PhClipboardText :size="13" weight="bold" />
        粘贴
        <span class="popup-menu-shortcut">{{ modKey }}+V</span>
      </button>
      <button v-else class="ctx-item popup-menu-item" disabled style="opacity:.4;cursor:default">
        <PhClipboardText :size="13" weight="bold" />
        剪贴板为空
      </button>
    </template>
  </ContextMenu>

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
import { filesApi, foldersApi, trashApi, uploadWithProgress } from '@/services/api'
import ContextMenu   from '@/components/ContextMenu.vue'
import FileInfoPopup from '@/components/common/FileInfoPopup.vue'
import { useClipboardStore } from '@/stores/clipboard'
import { uploadSignal } from '@/services/cache'
import { useProjectStore } from '@/stores/projects'
import { usePreviewStore, isPreviewable, isAudioExt } from '@/stores/preview'
import { fireHint } from '@/composables/useOnboarding'
import { useFilesCacheStore } from '@/stores/filesCache'
import { useLiveStore } from '@/stores/live'
import { useUiStore } from '@/stores/ui'
import { cardBlobReadyIds, clearThumbCache } from '@/composables/useThumbCache'
import { vLazyThumb as vLazySrc } from '@/composables/useLazyThumb'
import { isImageExt, fileExtCategory, fileIconColor, fileListIcon } from '@/utils/fileTypes'
import { useFileDragDrop } from '@/composables/useFileDragDrop'
import { useSorting } from '@/composables/useSorting'
import { useUploadQueue } from '@/composables/useUploadQueue'
import { readDroppedEntries, filesToItems, uploadFilesWithFolders, checkUploadConflicts } from '@/composables/useFileUpload'
import { useBoxSelection } from '@/composables/useBoxSelection'
import UploadConflictDialog from '@/components/common/UploadConflictDialog.vue'
import {
  PhFolder, PhUser, PhStack, PhTrash, PhCalendarBlank, PhCalendarDot,
  PhClock, PhPlayCircle, PhCheckCircle,
  PhBrowser,
  PhArrowLeft, PhArrowRight, PhSortAscending, PhSquaresFour, PhList,
  PhCheckSquare, PhCheck, PhFolderPlus, PhUploadSimple, PhPencilSimple,
  PhDownloadSimple, PhScissors, PhCopy, PhClipboardText, PhX,
  PhInfo, PhWarningCircle, PhDotsThree,
} from '@phosphor-icons/vue'

const projectStore = useProjectStore()
const cacheStore   = useFilesCacheStore()
const liveStore    = useLiveStore()
const uiStore      = useUiStore()

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
function fmtBytes(n) {
  if (!n) return '0 B'
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB'
  if (n >= 1048576)    return (n / 1048576).toFixed(1) + ' MB'
  if (n >= 1024)       return (n / 1024).toFixed(0) + ' KB'
  return n + ' B'
}
const storageFillStyle = computed(() => {
  if (!storageInfo.limit) return { width: '0%' }
  const pct = Math.min(100, (storageInfo.used / storageInfo.limit) * 100)
  const color = pct >= 90 ? '#c05050' : pct >= 70 ? '#b07858' : '#7b7fb2'
  return { width: pct + '%', background: color }
})

// ── 视图状态 ──
// 使用模块级 cardBlobReadyIds：首次 @load 后写入，session 内二次访问直接显示跳过动画
const viewMode    = ref('grid')
const loading     = ref(false)
const dragCounter = ref(0)
const isDragging  = computed(() => dragCounter.value > 0)
const mainRef     = ref(null)

// ── 导航 ──
interface NavSeg {
  type: string
  name: string
  color?: string | null
  id?: number | null
  status?: string | null
  year?: string | number | null
  month?: string | number | null
  folderId?: number | null
  projectId?: number | null
  space?: string
}
const navPath = ref<NavSeg[]>([])
const navHistoryStack  = ref([])
const navHistoryCursor = ref(-1)
let _isHistoryNav = false

const canGoBack    = computed(() => navHistoryCursor.value > 0)
const canGoForward = computed(() => navHistoryCursor.value < navHistoryStack.value.length - 1)

watch(navPath, (newVal) => {
  if (_isHistoryNav) return
  const snap = JSON.parse(JSON.stringify(newVal))
  navHistoryStack.value = navHistoryStack.value.slice(0, navHistoryCursor.value + 1)
  navHistoryStack.value.push(snap)
  navHistoryCursor.value = navHistoryStack.value.length - 1
}, { deep: true })

function goBack() {
  if (!canGoBack.value) return
  _isHistoryNav = true
  navHistoryCursor.value--
  navPath.value = JSON.parse(JSON.stringify(navHistoryStack.value[navHistoryCursor.value]))
  loadContents()
  nextTick(() => { _isHistoryNav = false })
}

function goForward() {
  if (!canGoForward.value) return
  _isHistoryNav = true
  navHistoryCursor.value++
  navPath.value = JSON.parse(JSON.stringify(navHistoryStack.value[navHistoryCursor.value]))
  loadContents()
  nextTick(() => { _isHistoryNav = false })
}

const currentType = computed(() => {
  if (navPath.value.length === 0) return 'root'
  return navPath.value[navPath.value.length - 1].type
})

const currentSeg  = computed(() => navPath.value[navPath.value.length - 1] ?? null)
const projectSeg  = computed(() => navPath.value.find(s => s.type === 'project') ?? null)
const canUpload   = computed(() => ['personal', 'project', 'folder'].includes(currentType.value))

const NAV_KEY = 'files_nav_path'

function saveNav() {
  sessionStorage.setItem(NAV_KEY, JSON.stringify(navPath.value))
}

function enterFolder(folder) {
  clearSelection()
  if (folder.type === 'personal') {
    navPath.value = [{ type: 'personal', name: '个人文件', color: null }]
  } else if (folder.type === 'projects') {
    navPath.value = [{ type: 'projects', name: '项目文件', color: null }]
  } else if (folder.type === 'trash') {
    navPath.value = [{ type: 'trash', name: '回收站', color: null }]
  } else if (folder.type === 'status') {
    navPath.value = [
      { type: 'projects', name: '项目文件', color: null },
      { type: 'status', status: folder.status, name: folder.displayName, color: null },
    ]
  } else if (folder.type === 'year') {
    navPath.value = [
      { type: 'projects', name: '项目文件', color: null },
      { type: 'status', status: 'done', name: '已完成', color: null },
      { type: 'year', name: folder.year + ' 年', year: folder.year, color: null },
    ]
  } else if (folder.type === 'month') {
    const yearSeg = navPath.value.find(s => s.type === 'year')
    navPath.value = [
      { type: 'projects', name: '项目文件', color: null },
      { type: 'status', status: 'done', name: '已完成', color: null },
      { type: 'year',  name: yearSeg.year + ' 年', year: yearSeg.year, color: null },
      { type: 'month', name: parseInt(folder.month) + ' 月', year: folder.year, month: folder.month, color: null },
    ]
  } else if (folder.type === 'project') {
    // 保留 状态 + 年月 上下文
    const path: NavSeg[] = [{ type: 'projects', name: '项目文件', color: null }]
    const statusSeg = navPath.value.find(s => s.type === 'status')
    const yearSeg  = navPath.value.find(s => s.type === 'year')
    const monthSeg = navPath.value.find(s => s.type === 'month')
    if (statusSeg) path.push({ ...statusSeg })
    if (yearSeg)  path.push({ ...yearSeg })
    if (monthSeg) path.push({ ...monthSeg })
    path.push({ type: 'project', id: folder.projectId, name: folder.displayName, color: folder.color })
    navPath.value = path
  } else if (folder.type === 'folder') {
    const seg = currentSeg.value
    if (seg?.type === 'personal') {
      navPath.value = [
        { type: 'personal', name: '个人文件', color: null },
        { type: 'folder', folderId: folder.folderId, name: folder.displayName, color: null, space: 'personal' },
      ]
    } else if (seg?.type === 'folder') {
      // 已在某个文件夹内，直接追加子文件夹
      navPath.value = [
        ...navPath.value,
        { type: 'folder', folderId: folder.folderId, name: folder.displayName,
          projectId: folder.projectId ?? seg.projectId, color: folder.color ?? seg.color },
      ]
    } else {
      // 保留到 project 层，追加 folder
      const projIdx = navPath.value.findIndex(s => s.type === 'project')
      const basePath = projIdx >= 0
        ? navPath.value.slice(0, projIdx + 1)
        : [{ type: 'projects', name: '项目文件', color: null },
           { type: 'project', id: folder.projectId, name: projectSeg.value?.name ?? '', color: folder.color }]
      navPath.value = [
        ...basePath,
        { type: 'folder', folderId: folder.folderId, name: folder.displayName, projectId: folder.projectId, color: folder.color },
      ]
    }
  }
  saveNav()
  loadContents()
}

function navigateTo(idx) {
  clearSelection()
  if (idx === -1) {
    navPath.value = []
  } else {
    navPath.value = navPath.value.slice(0, idx + 1)
  }
  saveNav()
  loadContents()
}

function restoreNav() {
  try {
    const saved = sessionStorage.getItem(NAV_KEY)
    if (!saved) return
    navPath.value = JSON.parse(saved)
  } catch {
    navPath.value = []
  }
}

// ── 顶栏全局搜索：定位到某个文件/文件夹所在目录 ──
function _folderChain(folderId) {
  // 从根到目标，沿 parentId 上溯，返回文件夹对象数组
  const chain = []
  const seen = new Set()
  let cur = cacheStore.getFolder(folderId)
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    chain.unshift(cur)
    cur = cur.parentId != null ? cacheStore.getFolder(cur.parentId) : null
  }
  return chain
}

function _basePath(projectId) {
  if (projectId != null) {
    const p = projectStore.projects.find(p => p.id === projectId)
    const base: NavSeg[] = [{ type: 'projects', name: '项目文件', color: null }]
    if (p) {
      const col = projectStore.kanbanColumns.find(c => c.key === p.status)
      base.push({ type: 'status', status: p.status, name: col?.label ?? '项目', color: null })
      if (p.status === 'done') {   // 已完成：补上 完成日期 的年 / 月 段，面包屑与正常进入一致
        const y = doneYear(p), m = doneMonth(p)
        base.push({ type: 'year', name: y + ' 年', year: y, color: null })
        base.push({ type: 'month', name: parseInt(m) + ' 月', year: y, month: m, color: null })
      }
    }
    base.push({ type: 'project', id: projectId, name: p?.name ?? '项目', color: p?.color ?? null })
    return base
  }
  return [{ type: 'personal', name: '个人文件', color: null }]
}

function _folderSeg(f) {
  return { type: 'folder', folderId: f.id, name: f.name ?? f.displayName,
           projectId: f.projectId ?? null, color: f.color ?? null }
}

async function jumpToTarget(target) {
  if (!target) return
  if (!cacheStore.loaded) await cacheStore.load()
  clearSelection()
  if (target.kind === 'folder') {
    const fo = cacheStore.getFolder(target.id)
    if (!fo) return
    navPath.value = [..._basePath(fo.projectId), ..._folderChain(fo.id).map(_folderSeg)]
  } else {
    const f = cacheStore.getFile(target.id)
    if (!f) return
    navPath.value = f.folderId != null
      ? [..._basePath(f.projectId), ..._folderChain(f.folderId).map(_folderSeg)]
      : _basePath(f.projectId)
  }
  saveNav()
  loadContents()
  if (target.kind === 'file') {
    await nextTick()
    _flashFile(target.id)
  }
}

function _flashFile(id) {
  // 等内容渲染 + 缩略图布局稳定后，滚到目标并高亮一下
  setTimeout(() => {
    const el = mainRef.value?.querySelector(`[data-file-id="${id}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('search-flash')
    setTimeout(() => el.classList.remove('search-flash'), 1800)
  }, 150)
}

// ── 排序 ──
const { SORT_OPTIONS, sortKey, sortDir, sortMenuOpen, sortBtnRef, sortMenuPos, openSortMenu, onSortSelect } = useSorting()

const sortedContents = computed(() => {
  const { folders, files } = contents.value
  // projects 层是「状态文件夹」，保持看板顺序（待开始→进行中→已完成），不参与排序
  if (currentType.value === 'root' || currentType.value === 'projects') return { folders, files }
  const dir = sortDir.value === 'asc' ? 1 : -1

  const sortedFolders = [...folders].sort((a, b) => {
    if (sortKey.value === 'name' || sortKey.value === 'type') {
      return dir * (a.displayName ?? '').localeCompare(b.displayName ?? '', 'zh')
    }
    return dir * ((a.id > b.id ? 1 : a.id < b.id ? -1 : 0))
  })

  const sortedFiles = [...files].sort((a, b) => {
    if (sortKey.value === 'name') {
      return dir * (a.displayName ?? '').localeCompare(b.displayName ?? '', 'zh')
    }
    if (sortKey.value === 'type') {
      const ca = fileExtCategory(a.ext), cb = fileExtCategory(b.ext)
      if (ca !== cb) return dir * ca.localeCompare(cb)
      return dir * (a.ext ?? '').localeCompare(b.ext ?? '')
    }
    if (sortKey.value === 'stage') {
      const sa = a.projectName || a.stageName || ''
      const sb = b.projectName || b.stageName || ''
      return dir * sa.localeCompare(sb, 'zh')
    }
    if (sortKey.value === 'createdAt') {
      return dir * (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
    }
    if (sortKey.value === 'size') {
      return dir * ((a.sizeBytes ?? 0) - (b.sizeBytes ?? 0))
    }
    return 0
  })

  return { folders: sortedFolders, files: sortedFiles }
})

// ── 内容 ──
const contents = ref({ folders: [], files: [] })
// tiny 已由 v-lazy-src 视口门控（更大 rootMargin 先于 card），不再全量预热——避免屏幕外缩略图挤占并发队列

function extractColor(colorStr) {
  if (!colorStr) return null
  const m = colorStr.match(/#[0-9a-fA-F]{3,6}/)
  return m ? m[0] : colorStr
}

// 已完成项目按「完成日期」doneAt 归档（与项目面板一致），fallback startDate/createdAt
function doneYear(p)  { return (p.doneAt || p.startDate || p.createdAt || '').slice(0, 4) || '未归类' }
function doneMonth(p) { return (p.doneAt || p.startDate || p.createdAt || '').slice(5, 7) || '00' }

// 状态文件夹的色 / 图标（待开始灰 / 进行中蓝 / 已完成绿）
const STATUS_COLOR = { pending: '#8a8fa8', active: '#5080c8', done: '#4a9a72' }
const STATUS_ICON  = { pending: PhClock,   active: PhPlayCircle, done: PhCheckCircle }

// 项目 → 文件夹卡
function projFolder(p) {
  return {
    id: `p:${p.id}`, type: 'project', displayName: p.name,
    color: extractColor(p.color), projectId: p.id,
    count: cacheStore.loaded ? cacheStore.allFiles.filter(f => f.projectId === p.id).length : null,
  }
}

function loadContents() {
  const type = currentType.value

  if (type === 'root') {
    // root 仍需知道回收站数量，但可以暗后台拉取（非阻塞）
    const personalCount = cacheStore.loaded
      ? cacheStore.getPersonalRootFiles().length + cacheStore.getPersonalRootFolders().length
      : null
    contents.value = {
      folders: [
        { id: 'personal', type: 'personal', displayName: '个人文件', count: personalCount },
        { id: 'projects', type: 'projects', displayName: '项目文件', count: projectStore.projects.length },
        { id: 'trash',    type: 'trash',    displayName: '回收站',   count: null },
      ],
      files: [],
    }
    trashApi.list().then(files => {
      const trashFolder = contents.value.folders.find(f => f.id === 'trash')
      if (trashFolder) trashFolder.count = files.length
    }).catch(() => {})
    return
  }

  if (type === 'trash') {
    loading.value = true
    trashApi.list()
      .then(files => { contents.value = { folders: [], files } })
      .catch(e => console.error('[Files]', e.message))
      .finally(() => { loading.value = false })
    return
  }

  if (type === 'personal') {
    const folderItems = cacheStore.getPersonalRootFolders().map(f => ({
      id: `f:${f.id}`, type: 'folder', folderId: f.id,
      displayName: f.name, color: null, space: 'personal',
      count: cacheStore.getFolderFiles(f.id).length,
    }))
    contents.value = { folders: folderItems, files: cacheStore.getPersonalRootFiles() }
    return
  }

  if (type === 'projects') {
    // 按项目状态分三组（待开始/进行中/已完成），看板顺序；空组不显示
    const cnt = {}
    for (const p of projectStore.projects) cnt[p.status] = (cnt[p.status] || 0) + 1
    const statusFolders = projectStore.kanbanColumns
      .filter(c => (cnt[c.key] || 0) > 0)
      .map(c => ({ id: `st:${c.key}`, type: 'status', status: c.key, displayName: c.label, count: cnt[c.key] }))
    contents.value = { folders: statusFolders, files: [] }
    return
  }

  if (type === 'status') {
    const { status } = currentSeg.value
    if (status === 'done') {
      // 已完成 → 按完成日期年份归档
      const yearMap = {}
      for (const p of projectStore.projects) {
        if (p.status !== 'done') continue
        const y = doneYear(p)
        yearMap[y] = (yearMap[y] || 0) + 1
      }
      const yearFolders = Object.keys(yearMap)
        .sort((a, b) => b.localeCompare(a))
        .map(y => ({ id: `y:${y}`, type: 'year', displayName: y + ' 年', year: y, count: yearMap[y] }))
      contents.value = { folders: yearFolders, files: [] }
    } else {
      // 待开始/进行中 → 直接列项目（不归档）
      const projs = projectStore.projects.filter(p => p.status === status)
      contents.value = { folders: projs.map(projFolder), files: [] }
    }
    return
  }

  if (type === 'year') {
    const { year } = currentSeg.value
    const monthMap = {}
    for (const p of projectStore.projects) {
      if (p.status !== 'done' || doneYear(p) !== year) continue
      const m = doneMonth(p)
      monthMap[m] = (monthMap[m] || 0) + 1
    }
    const monthFolders = Object.keys(monthMap)
      .sort()
      .map(m => ({ id: `m:${year}-${m}`, type: 'month', displayName: parseInt(m) + ' 月', year, month: m, count: monthMap[m] }))
    contents.value = { folders: monthFolders, files: [] }
    return
  }

  if (type === 'month') {
    const { year, month } = currentSeg.value
    const projs = projectStore.projects.filter(p => p.status === 'done' && doneYear(p) === year && doneMonth(p) === month)
    contents.value = { folders: projs.map(projFolder), files: [] }
    return
  }

  if (type === 'project') {
    const seg = currentSeg.value
    const folderItems = cacheStore.getProjectRootFolders(seg.id).map(f => ({
      id: `f:${f.id}`, type: 'folder', folderId: f.id,
      displayName: f.name, color: seg.color, projectId: seg.id,
      count: cacheStore.getFolderFiles(f.id).length,
    }))
    contents.value = { folders: folderItems, files: cacheStore.getProjectRootFiles(seg.id) }
    return
  }

  if (type === 'folder') {
    const seg = currentSeg.value
    const folderItems = cacheStore.getSubFolders(seg.folderId).map(f => ({
      id: `f:${f.id}`, type: 'folder', folderId: f.id,
      displayName: f.name, color: seg.color, projectId: seg.projectId ?? null,
      count: cacheStore.getFolderFiles(f.id).length,
    }))
    contents.value = { folders: folderItems, files: cacheStore.getFolderFiles(seg.folderId) }
    return
  }
}

onMounted(async () => {
  fireHint('file_lib')   // 新手引导：第一次进文件库
  fetchStorage()
  // 顶栏搜索点了文件/文件夹：优先定位到目标目录，不走 restoreNav
  const target = uiStore.pendingFileTarget
  uiStore.pendingFileTarget = null
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
  if (!target) return
  uiStore.pendingFileTarget = null
  jumpToTarget(target)
})

watch(uploadSignal, () => {
  // 上传信号由 uploadFiles 直接写入缓存；这里做一次静默后台刷新以纠偏
  cacheStore.refresh().then(() => loadContents())
  fetchStorage()
})

// 咕咕通过工具改了文件库（如保存上传附件 / 建文档 / 删除）→ 实时刷新当前视图
watch(() => liveStore.rev.files, () => {
  cacheStore.refresh().then(() => loadContents())
  fetchStorage()
})

// ── 框选 ──
const lastAnchorIndex = ref(-1)

const {
  selectedFileIds: selectedIds,
  selectedFolderIds: selectedFolderKeys,
  previewFileIds,
  previewFolderIds: previewFolderKeys,
  boxStart, selectionRect,
  onContainerMouseDown: _boxMouseDown,
  cancelDrag: _cancelBoxDrag,
  clearSelection: _clearSelBase,
  toggleFileSelect: toggleFileSelectSimple,
  toggleFolderSelect,
} = useBoxSelection(mainRef, {
  fileAttr: 'data-file-id',
  folderAttr: 'data-folder-key',
  excludeSelector: 'button, .fc-card, .folder-card, .fc-upload, .list-row',
  onBoxSelect: ({ fileIds, folderIds }, e) => {
    if (e.shiftKey) {
      const ids  = new Set(selectedIds.value)
      const keys = new Set(selectedFolderKeys.value)
      fileIds.forEach(id => ids.add(id)); selectedIds.value = ids
      folderIds.forEach(k => keys.add(k)); selectedFolderKeys.value = keys
    } else {
      selectedIds.value        = fileIds
      selectedFolderKeys.value = folderIds
    }
    // 把锚点设到框选结果里最末尾的那项，便于后续 shift+click 继续延伸
    const flat = flatSelectableItems.value
    for (let i = flat.length - 1; i >= 0; i--) {
      const item = flat[i]
      if ((item.type === 'file' && fileIds.has(item.id)) ||
          (item.type === 'folder' && folderIds.has(item.id))) {
        lastAnchorIndex.value = i; break
      }
    }
  },
})

function clearSelection() {
  _clearSelBase()
  selectModeForced.value = false
  lastAnchorIndex.value  = -1
}

function onMainMouseDown(e) {
  if (currentType.value === 'root' || currentType.value === 'projects') return
  _boxMouseDown(e)
}

// ── Shift 多选 ──
const flatSelectableItems = computed(() => [
  ...sortedContents.value.folders.map(f => ({ type: 'folder', id: f.id })),
  ...sortedContents.value.files.map(f => ({ type: 'file', id: f.id })),
])

function _shiftSelect(type, id) {
  const idx = flatSelectableItems.value.findIndex(i => i.type === type && i.id === id)
  if (idx < 0) return false
  const anchor = lastAnchorIndex.value
  if (anchor < 0) return false
  const [a, b] = anchor <= idx ? [anchor, idx] : [idx, anchor]
  const ids  = new Set<number>()
  const keys = new Set<number | string>()
  flatSelectableItems.value.slice(a, b + 1).forEach(item => {
    if (item.type === 'file') ids.add(item.id)
    else keys.add(item.id)
  })
  selectedIds.value        = ids
  selectedFolderKeys.value = keys
  return true
}

function handleFolderClick(folder, event) {
  if (event.shiftKey) {
    if (!_shiftSelect('folder', folder.id)) {
      // 没有锚点时 shift+click 当作普通选中，设置锚点，不导航
      toggleFolderSelect(folder.id)
      lastAnchorIndex.value = flatSelectableItems.value.findIndex(i => i.type === 'folder' && i.id === folder.id)
    }
    return
  }
  if (inSelectionMode.value) {
    toggleFolderSelect(folder.id)
    lastAnchorIndex.value = flatSelectableItems.value.findIndex(i => i.type === 'folder' && i.id === folder.id)
  } else {
    enterFolder(folder)
  }
}

function handleFileClick(file, event) {
  if (event.shiftKey) {
    if (!_shiftSelect('file', file.id)) {
      // 没有锚点时 shift+click 当作普通选中，设置锚点
      toggleFileSelectSimple(file.id)
      lastAnchorIndex.value = flatSelectableItems.value.findIndex(i => i.type === 'file' && i.id === file.id)
    }
    return
  }
  if (inSelectionMode.value) {
    toggleFileSelectSimple(file.id)
    lastAnchorIndex.value = flatSelectableItems.value.findIndex(i => i.type === 'file' && i.id === file.id)
  } else if (isPreviewable(file.ext)) {
    openPreview(file)
  } else {
    toggleFileSelect(file.id, event)
    lastAnchorIndex.value = flatSelectableItems.value.findIndex(i => i.type === 'file' && i.id === file.id)
  }
}

const selectModeForced = ref(false)
const inSelectionMode  = computed(() => selectModeForced.value || selectedIds.value.size > 0 || selectedFolderKeys.value.size > 0)
const downloadingZip   = ref(false)

function toggleSelectMode() {
  if (inSelectionMode.value) {
    selectModeForced.value = false
    clearSelection()
  } else {
    selectModeForced.value = true
  }
}

// 回收站全选 / 取消全选
const allTrashSelected = computed(() => {
  const files = sortedContents.value.files
  return files.length > 0 && files.every(f => selectedIds.value.has(f.id))
})
function toggleSelectAllTrash() {
  if (allTrashSelected.value) {
    clearSelection()
  } else {
    selectModeForced.value = true
    selectedIds.value = new Set(sortedContents.value.files.map(f => f.id))
  }
}

function toggleFileSelect(fileId, e) {
  const ids = new Set(selectedIds.value)
  if (e.ctrlKey || e.metaKey) {
    if (ids.has(fileId)) ids.delete(fileId)
    else ids.add(fileId)
  } else {
    if (ids.size === 1 && ids.has(fileId)) ids.clear()
    else { ids.clear(); ids.add(fileId) }
  }
  selectedIds.value = ids
}

function onPageClick() {
  if (!inSelectionMode.value) clearSelection()
  sortMenuOpen.value = false
}

// ── 删除 ──
async function deleteSingleFile(f) {
  const backup = cacheStore.getFile(f.id)
  cacheStore.removeFile(f.id)
  selectedIds.value = new Set([...selectedIds.value].filter(id => id !== f.id))
  loadContents()
  try {
    await filesApi.delete(f.id)
  } catch (e) {
    if (backup) cacheStore.addFile(backup)
    loadContents()
    console.error('[Files] 删除失败:', e.message)
  }
}

async function downloadSelected() {
  if (downloadingZip.value) return
  const ids = [...selectedIds.value]
  const folderObjs = contents.value.folders.filter(f => selectedFolderKeys.value.has(f.id))
  const folderIds = folderObjs.map(f => f.folderId)
  if (!ids.length && !folderIds.length) return

  downloadingZip.value = true
  try {
    // 单个文件 → 直接下载
    if (ids.length === 1 && folderIds.length === 0) {
      const f = sortedContents.value.files?.find(f => f.id === ids[0])
      if (f) await filesApi.download(f.id, `${f.displayName}.${f.ext}`)
      return
    }
    // 单个文件夹 → 以文件夹名打包
    if (folderIds.length === 1 && ids.length === 0) {
      await foldersApi.download(folderIds[0], folderObjs[0].displayName)
      return
    }
    // 多选 → 以当前目录名打包
    const dirName = currentSeg.value?.name ?? '文件'
    await filesApi.batchDownload(ids, folderIds, `${dirName}.zip`)
  } catch (e) {
    console.error('[Files] 批量下载失败:', e.message)
  } finally {
    downloadingZip.value = false
  }
}

async function deleteSelected() {
  const hasFiles   = selectedIds.value.size > 0
  const hasFolders = selectedFolderKeys.value.size > 0
  if (!hasFiles && !hasFolders) return

  const fileIds     = [...selectedIds.value]
  const folderMap   = new Map(contents.value.folders.map(f => [f.id, f.folderId]))
  const folderIds   = [...selectedFolderKeys.value].map(k => folderMap.get(k)).filter(Boolean)
  const fileBackups = fileIds.map(id => cacheStore.getFile(id)).filter(Boolean)

  // 乐观更新
  if (hasFiles)   cacheStore.removeFiles(fileIds)
  if (hasFolders) { pruneHistoryForFolders(folderIds); folderIds.forEach(id => cacheStore.removeFolder(id)) }
  selectedIds.value        = new Set()
  selectedFolderKeys.value = new Set()
  loadContents()

  try {
    const tasks = []
    if (hasFiles)   tasks.push(filesApi.batchDelete(fileIds))
    if (hasFolders) folderIds.forEach(id => tasks.push(foldersApi.delete(id)))
    await Promise.all(tasks)
  } catch (e) {
    // 回滚
    fileBackups.forEach(f => cacheStore.addFile(f))
    loadContents()
    console.error('[Files] 批量删除失败:', e.message)
  }
}

// ── 回收站操作 ──
async function restoreFile(f) {
  try {
    await trashApi.restore(f.id)
    loadContents()
    liveStore.bump('files')
  } catch (e) {
    console.error('[Files] 恢复失败:', e.message)
  }
}

async function hardDeleteFile(f) {
  if (!confirm(`永久删除「${f.displayName}.${f.ext.toLowerCase()}」？此操作不可撤销。`)) return
  try {
    await trashApi.hardDelete(f.id)
    loadContents()
  } catch (e) {
    console.error('[Files] 永久删除失败:', e.message)
  }
}

function handleTrashFileClick(f, event) {
  if (event.target.closest('button')) return
  const ids = new Set(selectedIds.value)
  if (ids.has(f.id)) ids.delete(f.id)
  else ids.add(f.id)
  selectedIds.value = ids
}

async function restoreSelected() {
  const ids = [...selectedIds.value]
  if (!ids.length) return
  try {
    await Promise.all(ids.map(id => trashApi.restore(id)))
    clearSelection()
    loadContents()
    liveStore.bump('files')
  } catch (e) {
    console.error('[Files] 批量恢复失败:', e.message)
  }
}

async function hardDeleteSelected() {
  const ids = [...selectedIds.value]
  if (!ids.length) return
  if (!confirm(`永久删除选中的 ${ids.length} 个文件？此操作不可撤销。`)) return
  try {
    await Promise.all(ids.map(id => trashApi.hardDelete(id)))
    clearSelection()
    loadContents()
  } catch (e) {
    console.error('[Files] 批量永久删除失败:', e.message)
  }
}

async function confirmEmptyTrash() {
  if (!confirm('清空回收站？所有文件将被永久删除，无法恢复。')) return
  try {
    await trashApi.empty()
    loadContents()
  } catch (e) {
    console.error('[Files] 清空回收站失败:', e.message)
  }
}

// ── 回收站工具函数 ──
function daysLeft(deletedAt) {
  if (!deletedAt) return 30
  const gone = Math.floor((Date.now() - new Date(deletedAt).getTime()) / 86400000)
  return Math.max(0, 30 - gone)
}

function formatDate(iso) {
  return iso ? iso.slice(0, 10) : '—'
}

// ── 上传 ──
const { uploadingItems, createGhost, updateGhostProgress, removeGhost, failGhost, createFolderGhost, bumpFolderGhost } = useUploadQueue()

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
    const real = await foldersApi.create(projectId, name, parentId)
    cacheStore.removeFolder(tempId)
    cacheStore.addFolder({ id: real.id, name: real.name, projectId: real.projectId ?? null, parentId: real.parentId ?? null, fileCount: 0 })
    loadContents()
  } catch (e) {
    cacheStore.removeFolder(tempId)
    loadContents()
    console.error('[Files] 新建文件夹失败:', e.message)
  } finally {
    newFolderLoading.value = false
  }
}

// items: UploadItem[]（{file, relativePath}）——relativePath 带 "/" 时来自拖入的文件夹，
// 由 uploadFilesWithFolders 按路径建好子文件夹再落到各自正确的 folder_id。
// items: UploadItem[]（{file, relativePath}）——relativePath 带 "/" 时来自拖入的文件夹，
// 由 uploadFilesWithFolders 按路径建好子文件夹再落到各自正确的 folder_id。
const conflictDialogRef = ref(null)

async function uploadFiles(items) {
  if (!items.length) return
  const type = currentType.value
  const seg  = currentSeg.value
  let space = 'personal', projectId = null, folderId = null
  if (type === 'project' && seg) {
    space = 'project'; projectId = seg.id
  } else if (type === 'folder' && seg) {
    folderId = seg.folderId
    if (seg.projectId) { space = 'project'; projectId = seg.projectId }
  }

  // 上传前探测同名冲突（只查直接落在这个文件夹的顶层文件，子文件夹本身是新建的不会冲突）；
  // 有冲突才弹列表式确认，选「跳过」的文件直接从这批里剔除，不会真的发上传请求。
  const conflicts = await checkUploadConflicts(items, { space, projectId, folderId })
  let decisions = new Map()
  if (conflicts.length) {
    decisions = await conflictDialogRef.value.show(conflicts)
    items = items.filter(it => decisions.get(it.relativePath)?.action !== 'skip')
    if (!items.length) return
  }

  // 按顶层文件夹分组：relativePath 带 "/" 的文件汇总进「文件夹名 · 完成数/总数」一张卡，
  // 不用每个文件各出一张（大部分还落在当前看不见的子文件夹里，刷屏也看不出意义）；
  // 没有 "/" 的（本来就是单文件，或文件夹里就直接是文件不算——理论上不会有这种）仍各自一张卡。
  const folderGhosts = new Map()
  for (const { relativePath } of items) {
    const idx = relativePath.indexOf('/')
    if (idx === -1) continue
    const top = relativePath.slice(0, idx)
    if (!folderGhosts.has(top)) folderGhosts.set(top, null)
  }
  for (const top of folderGhosts.keys()) {
    const total = items.filter(it => it.relativePath.startsWith(top + '/')).length
    folderGhosts.set(top, createFolderGhost(top, total))
  }
  // 顶层文件夹（正被 ghost 追踪进度的那几个）先别实时插进可见列表——插了会跟它的 ghost 卡
  // 同时出现，看起来像「两个文件夹」。攒着，等这组文件全传完（ghost 即将消失那一刻）再插入，
  // 从「上传中」无缝换成「已完成」。更深层的子文件夹本来就不在当前视图里，直接插不会重复。
  const pendingTopFolders = new Map()

  await uploadFilesWithFolders(items, {
    projectId, baseFolderId: folderId,
    onFolderCreated: (created) => {
      if (folderGhosts.has(created.name) && (created.parentId ?? null) === folderId) {
        pendingTopFolders.set(created.name, created)
      } else {
        cacheStore.addFolder(created)
      }
    },
    uploadOne: async (file, resolvedFolderId, relativePath) => {
      const top = relativePath.includes('/') ? relativePath.slice(0, relativePath.indexOf('/')) : null
      const folderGhost = top ? folderGhosts.get(top) : null
      const ghost = folderGhost ? null : createGhost(
        (() => { const i = file.name.lastIndexOf('.'); return i > -1 ? file.name.slice(0, i) : file.name })(),
        (() => { const i = file.name.lastIndexOf('.'); return i > -1 ? file.name.slice(i + 1).toUpperCase() : '' })(),
      )
      // 这组文件全处理完（不管成功失败）就把攒着的真实文件夹插进可见列表——跟成功/失败两条
      // 路径都要走，否则「文件夹最后一个文件恰好失败」时永远插不进去
      const settleFolder = (failed) => {
        if (!folderGhost) return
        bumpFolderGhost(folderGhost, failed)
        if (folderGhost.done >= folderGhost.total && pendingTopFolders.has(top)) {
          cacheStore.addFolder(pendingTopFolders.get(top))
          pendingTopFolders.delete(top)
        }
      }
      try {
        const form = new FormData()
        form.append('file', file)
        form.append('space', space)
        if (projectId)        form.append('project_id', String(projectId))
        if (resolvedFolderId) form.append('folder_id', String(resolvedFolderId))
        const decision = decisions.get(relativePath)
        if (decision?.action === 'overwrite' && decision.existingFileId) {
          form.append('on_conflict', 'overwrite')
          form.append('overwrite_file_id', String(decision.existingFileId))
        }
        const created = await uploadWithProgress('/files', form, p => { if (ghost) updateGhostProgress(ghost, p) })
        if (ghost) removeGhost(ghost)
        else settleFolder(false)
        if (decision?.action === 'overwrite' && decision.existingFileId) {
          // 覆盖：同一个文件 id 换了内容，更新缓存里的这条记录而不是插一条新的；旧缩略图
          // 客户端缓存也要清掉，否则卡片显示的还是覆盖前的图（服务端缓存已经在后端清过）。
          cacheStore.updateFile(decision.existingFileId, created)
          clearThumbCache(decision.existingFileId)   // 顺带清 thumbLoadedIds/cardBlobReadyIds
        } else {
          cacheStore.addFile(created)
        }
        loadContents()
        fetchStorage()
      } catch (e) {
        console.error('[Files] 上传失败:', e.message)
        if (ghost) failGhost(ghost)
        else settleFolder(true)
      }
    },
  })
}

async function handleFileInput(e) {
  await uploadFiles(filesToItems(e.target.files))
  e.target.value = ''
}

// ── 拖拽上传 ──
function onDragEnter(e) {
  if (canUpload.value && e.dataTransfer?.types?.includes('Files')) dragCounter.value++
}
function onDragLeave() {
  dragCounter.value = Math.max(0, dragCounter.value - 1)
}
async function handleDrop(e) {
  dragCounter.value = 0
  if (!canUpload.value) return
  const items = await readDroppedEntries(e.dataTransfer)
  if (items.length) uploadFiles(items)
}

// ── 预览 ──
const previewStore = usePreviewStore()
const openPreview = (f) => {
  if (isAudioExt(f.ext)) fireHint('music')   // 新手引导：第一次打开音乐文件（🎵😌 彩蛋）
  previewStore.open(f, sortedContents.value.files)
}

// ── 下载 ──
async function downloadFile(f) {
  try {
    await filesApi.download(f.id, `${f.displayName}.${f.ext.toLowerCase()}`)
  } catch (e) {
    console.error('[Files] 下载失败:', e.message)
  }
}

// ── 重命名 ──
const renamingFileId    = ref(null)
const renamingFolderKey = ref(null)
const renameText        = ref('')

function startRenameFile(f) {
  renamingFolderKey.value = null
  renamingFileId.value    = f.id
  renameText.value        = f.displayName
  nextTick(() => document.querySelector<HTMLInputElement>('.rename-input-inline')?.select())
}

function startRenameFolder(f) {
  renamingFileId.value    = null
  renamingFolderKey.value = f.folderId
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
    filesApi.update(fileId, { displayName: name }).catch(e => {
      if (oldName != null) cacheStore.updateFile(fileId, { displayName: oldName })
      loadContents()
      console.error('[Files] 重命名失败:', e.message)
    })
  } else {
    const oldName = cacheStore.getFolder(folderId)?.name
    cacheStore.updateFolder(folderId, { name })
    loadContents()
    foldersApi.rename(folderId, name).catch(e => {
      if (oldName != null) cacheStore.updateFolder(folderId, { name: oldName })
      loadContents()
      console.error('[Files] 重命名失败:', e.message)
    })
  }
}

async function downloadFolder(f) {
  try {
    await foldersApi.download(f.folderId, f.displayName)
  } catch (e) {
    console.error('[Files] 下载文件夹失败:', e.message)
  }
}

// ── 拖动移动 ──
// pointer 模式（setPointerCapture 自建拖拽，不是原生 HTML5 draggable/dragstart——原生拖拽从
// dragstart 起浏览器会整段暂停 mouseover/mouseout 派发，导致落地揭示卡片时 hover 高亮跳变，
// perf trace 实测证实）。抓取判断单选/多选 → 起 startPhysicsDrag/startMultiPhysicsDrag → 拖拽
// 中找落点高亮 → 松手判定目标并派发移动，这套编排跟 ProjectModal.vue 的文件面板完全一样，抽成
// 了共享 composable useFileDragDrop，这里只提供 Files 特有的选择器/面包屑规则/落地 API。
function isBcDroppable(seg) {
  return seg.type === 'folder' || seg.type === 'personal'
}

async function moveFoldersInto(folderIds, targetFolderId) {
  const backups = folderIds.map(id => cacheStore.getFolder(id)).filter(Boolean)
  folderIds.forEach(id => cacheStore.updateFolder(id, { parentId: targetFolderId }))
  loadContents()
  try {
    await Promise.all(folderIds.map(id => foldersApi.move(id, targetFolderId)))
  } catch (err) {
    backups.forEach(b => cacheStore.updateFolder(b.id, { parentId: b.parentId }))
    loadContents()
    console.error('[Files] 移动文件夹失败:', err.message)
  }
}
async function moveFilesInto(fileIds, targetFolderId) {
  const backups = fileIds.map(id => cacheStore.getFile(id)).filter(Boolean)
  fileIds.forEach(id => cacheStore.updateFile(id, { folderId: targetFolderId }))
  loadContents()
  try {
    await Promise.all(fileIds.map(id => filesApi.update(id, { folderId: targetFolderId })))
  } catch (err) {
    backups.forEach(f => cacheStore.updateFile(f.id, { folderId: f.folderId }))
    loadContents()
    console.error('[Files] 移动失败:', err.message)
  }
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
    return { targetFolderId: seg.type === 'folder' ? seg.folderId : null, acceptsFiles: true, acceptsFolders: true }
  },
  cancelBoxDrag: () => _cancelBoxDrag(),
  clearSelection() { selectedFolderKeys.value = new Set(); selectedIds.value = new Set() },
  moveFolders: moveFoldersInto,
  moveFiles: moveFilesInto,
})

// selectedFolderKeys 里放的是 f.id（"f:65"），拖拽需要真实数字 folderId——查当前层文件夹列表换算
function _selectedFolderIdNums() {
  const folderMap = new Map(sortedContents.value.folders.map(f => [f.id, f.folderId]))
  return new Set([...selectedFolderKeys.value].map(k => folderMap.get(k)).filter(v => v != null))
}

function onFolderPointerDown(f, e) {
  // 全部文件根目录下"个人文件/项目文件/回收站"是伪文件夹卡片（type 不是 'folder'，没有真实
  // folderId），不能拖拽——之前没挡，f.folderId 是 undefined，落点判定/吸入动画照样能触发
  // （只是数据层最终 API 调用会因 id 无效而静默失败），表现为"能拖进别的卡片，但只有动画有效果"。
  if (f.type !== 'folder') return
  _onFolderPointerDown(e, {
    itemId: f.folderId,
    isSelected: selectedFolderKeys.value.has(f.id),
    selectedFileIds: selectedIds.value,
    selectedFolderIds: _selectedFolderIdNums(),
  })
}
function onFilePointerDown(f, e) {
  _onFilePointerDown(e, {
    itemId: f.id,
    isSelected: selectedIds.value.has(f.id),
    selectedFileIds: selectedIds.value,
    selectedFolderIds: _selectedFolderIdNums(),
  })
}

function pruneHistoryForFolders(folderIds) {
  const idSet = new Set(folderIds)
  const hasDeleted = snap => snap.some(seg => seg.type === 'folder' && idSet.has(seg.folderId))
  const curIdx = navHistoryCursor.value
  let newCursor = 0
  const kept = []
  navHistoryStack.value.forEach((snap, i) => {
    if (!hasDeleted(snap)) {
      if (i <= curIdx) newCursor = kept.length
      kept.push(snap)
    }
  })
  navHistoryStack.value = kept
  navHistoryCursor.value = Math.min(newCursor, Math.max(0, kept.length - 1))
}

async function deleteFolder(f) {
  if (!confirm(`删除文件夹"${f.displayName}"？文件夹内所有内容将被删除。`)) return
  pruneHistoryForFolders([f.folderId])
  cacheStore.removeFolder(f.folderId)
  loadContents()
  try {
    await foldersApi.delete(f.folderId)
  } catch (e) {
    // 无法回滚（不知道子结构），静默刷新
    cacheStore.refresh().then(() => loadContents())
    console.error('[Files] 删除文件夹失败:', e.message)
  }
}

// ── 样式工具 ──
function folderIconStyle(folder) {
  if (folder.type === 'personal') return { background: 'rgba(180,148,80,0.14)',  color: '#b49450' }
  if (folder.type === 'projects') return { background: 'rgba(123,127,178,0.13)', color: '#7b7fb2' }
  if (folder.type === 'trash')    return { background: 'rgba(220,80,80,0.1)',    color: '#c85a5a' }
  if (folder.type === 'status')   { const c = STATUS_COLOR[folder.status] || '#7b7fb2'; return { background: c + '1f', color: c } }
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

function folderListIcon(folder) {
  if (folder.type === 'personal') return PhUser
  if (folder.type === 'projects') return PhStack
  if (folder.type === 'trash')    return PhTrash
  if (folder.type === 'status')   return STATUS_ICON[folder.status] || PhStack
  if (folder.type === 'year')     return PhCalendarBlank
  if (folder.type === 'month')    return PhCalendarDot
  if (folder.type === 'project')  return PhBrowser
  return PhFolder
}

function folderAccentColor(folder) {
  if (folder.type === 'personal') return '#967858'
  if (folder.type === 'projects') return '#6878a8'
  if (folder.type === 'trash')    return '#987070'
  if (folder.type === 'status')   return STATUS_COLOR[folder.status] || '#8888a8'
  if (folder.type === 'year')     return '#508878'
  if (folder.type === 'month')    return '#5878a8'
  if (folder.color) return folder.color
  return '#8888a8'
}

const folderInputRef = ref(null)
watch(showNewFolderInput, (v) => { if (v) nextTick(() => folderInputRef.value?.focus()) })

// ── 剪贴板 & 右键菜单 ────────────────────────────────────────────────────────
const isMac = navigator.platform.toUpperCase().includes('MAC') || navigator.userAgent.includes('Mac')
const modKey = isMac ? '⌘' : 'Ctrl'
const cbStore = useClipboardStore()

const ctx = ref({ visible: false, x: 0, y: 0, type: null, target: null })
const infoPopup = ref({ show: false, file: null, x: 0, y: 0 })

function selCut() {
  const fids = [...selectedIds.value]
  const dids = [...selectedFolderKeys.value].map(k => contents.value.folders.find(f => f.id === k)?.folderId).filter(Boolean)
  cbStore.cut(fids, dids)
  clearSelection()
}
function selCopy() {
  cbStore.copy([...selectedIds.value], [])
  clearSelection()
}

function openCtx(type, target, e) {
  // 如果右键点到已选中的文件，切换为多选菜单
  if (type === 'file' && (selectedIds.value.has(target.id) || selectedFolderKeys.value.size > 0) &&
      (selectedIds.value.size + selectedFolderKeys.value.size) > 1) {
    type = 'multi-file'
  }
  ctx.value = { visible: true, x: e.clientX, y: e.clientY, type, target }
}

// 当前目录的 folder_id（null = 根目录）
function currentFolderId() {
  const seg = currentSeg.value
  return seg?.type === 'folder' ? seg.folderId : null
}

// ── 文件操作 ──
function ctxInfo() {
  const f = ctx.value.target
  ctx.value.visible = false
  if (f) infoPopup.value = { show: true, file: f, x: ctx.value.x, y: ctx.value.y }
}

async function ctxDownload() {
  ctx.value.visible = false
  const ids = ctx.value.type === 'multi-file'
    ? [...selectedIds.value]
    : [ctx.value.target.id]
  if (ids.length === 1) {
    const f = sortedContents.value.files.find(f => f.id === ids[0])
    if (f) await filesApi.download(f.id, `${f.displayName}.${f.ext}`)
  } else {
    const dirName = currentSeg.value?.name ?? '文件'
    await filesApi.batchDownload(ids, [], `${dirName}.zip`)
  }
}
function ctxRename() {
  const f = ctx.value.target; ctx.value.visible = false
  startRenameFile(f)
}
function ctxCut() {
  const ids = ctx.value.type === 'multi-file'
    ? [...selectedIds.value] : [ctx.value.target.id]
  cbStore.cut(ids, []); ctx.value.visible = false
}
function ctxCopy() {
  const ids = ctx.value.type === 'multi-file'
    ? [...selectedIds.value] : [ctx.value.target.id]
  cbStore.copy(ids, []); ctx.value.visible = false
}
async function ctxDelete() {
  ctx.value.visible = false
  const ids = ctx.value.type === 'multi-file'
    ? [...selectedIds.value] : [ctx.value.target.id]
  try {
    await Promise.all(ids.map(id => filesApi.delete(id)))
    selectedIds.value = new Set()
    loadContents()
  } catch (e) { console.error(e) }
}

// ── 文件夹操作 ──
function ctxDownloadFolder() {
  const f = ctx.value.target; ctx.value.visible = false
  downloadFolder(f)
}
function ctxRenameFolder() {
  const f = ctx.value.target; ctx.value.visible = false
  startRenameFolder(f)
}
function ctxCutFolder() {
  cbStore.cut([], [ctx.value.target.folderId]); ctx.value.visible = false
}
async function ctxDeleteFolder() {
  const f = ctx.value.target; ctx.value.visible = false
  await deleteFolder(f)
}

// ── 粘贴 ──
async function ctxPaste() {
  ctx.value.visible = false
  const folderId = currentFolderId()
  const seg = currentSeg.value
  const projectId = seg?.type === 'project' ? seg.id : (seg?.projectId ?? null)
  try {
    if (cbStore.type === 'cut') {
      const backups = cbStore.fileIds.map(id => cacheStore.getFile(id)).filter(Boolean)
      cbStore.fileIds.forEach(id => cacheStore.updateFile(id, { folderId, projectId }))
      cbStore.clear()
      loadContents()
      try {
        await Promise.all(backups.map(f => filesApi.update(f.id, { folderId, projectId })))
      } catch (e) {
        backups.forEach(f => cacheStore.updateFile(f.id, { folderId: f.folderId, projectId: f.projectId }))
        loadContents()
        console.error('[Files] 粘贴失败:', e)
      }
    } else if (cbStore.type === 'copy') {
      const created = await Promise.all(cbStore.fileIds.map(id =>
        filesApi.copy(id, { folderId, projectId })
      ))
      created.forEach(f => cacheStore.addFile(f))
      loadContents()
    }
  } catch (e) { console.error('[Files] 粘贴失败:', e) }
}

// ── 键盘快捷键 ──
function onKeyDown(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
  const ctrl = e.ctrlKey || e.metaKey
  if (ctrl && e.key === 'x') {
    const fids = [...selectedIds.value]; const dids = [...selectedFolderKeys.value].map(k => contents.value.folders.find(f => f.id === k)?.folderId).filter(Boolean)
    if (fids.length || dids.length) { cbStore.cut(fids, dids); e.preventDefault() }
  } else if (ctrl && e.key === 'c') {
    const fids = [...selectedIds.value]
    if (fids.length) { cbStore.copy(fids, []); e.preventDefault() }
  } else if (ctrl && e.key === 'v') {
    if (cbStore.hasContent()) { ctxPaste(); e.preventDefault() }
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
.sort-selector { position: relative; }
.sort-btn {
  display: flex; align-items: center; gap: 5px;
  height: 30px; padding: 0 10px; border-radius: 8px; border: none;
  background: rgba(255,255,255,0.55); cursor: pointer;
  font-size: 12px; font-weight: 600; color: var(--color-primary);
  font-family: var(--font-sans); transition: background 0.15s, color 0.15s;
}
.sort-btn:hover { background: rgba(255,255,255,0.82); }
.sort-dir-icon { transition: transform 0.2s; }
.sort-dir-icon.desc { transform: rotate(180deg); }
/* 排序弹窗经 ContextMenu(Teleport 到 body)渲染，外观与右键菜单完全一致 */
.sort-check { flex-shrink: 0; margin-left: auto; color: var(--color-primary); }
.sort-check.desc { transform: rotate(180deg); }

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

.select-all-btn {
  height: 28px; padding: 0 12px; border-radius: 6px; border: none;
  background: rgba(255,255,255,0.55); cursor: pointer; color: var(--color-primary);
  font-size: 12px; font-weight: 600; font-family: var(--font-sans); white-space: nowrap;
  display: flex; align-items: center;
  transition: background 0.15s, color 0.15s, box-shadow 0.15s;
}
.select-all-btn:not(.on):hover { background: rgba(255,255,255,0.82); }
.select-all-btn.on {
  background: rgba(255,255,255,0.92); color: var(--color-primary);
  box-shadow: 0 1px 4px rgba(0,0,0,0.08);
}

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
  display: flex; background: rgba(0,0,0,0.05);
  border-radius: 8px; padding: 2px; gap: 2px;
  flex-shrink: 0;   /* 工具栏拥挤时不被挤压，否则按钮/带 viewBox 的 SVG 会缩成 2~3px（首屏/久置后布局最紧时最明显）*/
}
.view-toggle button {
  width: 28px; height: 28px; border-radius: 6px; border: none;
  background: none; cursor: pointer; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  transition: background 0.15s, color 0.15s, box-shadow 0.15s;
  flex-shrink: 0;
}
.view-toggle button svg { flex-shrink: 0; }
.view-toggle button.on {
  background: rgba(255,255,255,0.85); color: var(--color-primary);
  box-shadow: 0 1px 4px rgba(0,0,0,0.08);
}

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

/* 清空回收站 */
.empty-trash-btn {
  display: flex; align-items: center; gap: 5px;
  padding: 6px 12px; border-radius: 8px;
  border: 1px solid rgba(200,90,90,0.3); background: rgba(200,90,90,0.06);
  font-size: 12px; font-weight: 500; color: #c85a5a;
  cursor: pointer; font-family: var(--font-sans); transition: all 0.15s;
}
.empty-trash-btn:hover { background: rgba(200,90,90,0.12); border-color: #c85a5a; }

/* 存储用量 */
.storage-pill {
  display: flex; align-items: center; gap: 7px;
  padding: 0 4px; height: 30px;
  flex-shrink: 0;
}
.storage-pill.no-limit {}
.storage-bar-bg {
  width: 52px; height: 3px; border-radius: 2px; flex-shrink: 0;
  background: rgba(0,0,0,0.07); overflow: hidden;
}
.storage-bar-fill { height: 100%; border-radius: 2px; transition: width 0.4s ease, background 0.4s; }
.storage-text { font-size: 11px; color: #8a8fa8; white-space: nowrap; }

/* 上传按钮 */
.upload-btn {
  display: flex; align-items: center; gap: 5px;
  height: 30px; padding: 0 13px; border-radius: 8px; border: none;
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  color: white; font-size: 12px; font-weight: 600;
  cursor: pointer; font-family: var(--font-sans);
  box-shadow: 0 2px 8px rgba(123,127,178,0.28);
  transition: opacity 0.15s; white-space: nowrap;
}
.upload-btn:hover { opacity: 0.88; }

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
.files-main.is-selecting .folder-card {
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
.folder-card.pre-selected {
  border-color: rgba(123,127,178,0.38);
  background: rgba(123,127,178,0.05);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 0 0 1.5px rgba(123,127,178,0.12);
}
.list-row.pre-selected {
  background: rgba(123,127,178,0.06);
  outline: 1px solid rgba(123,127,178,0.25);
}

/* ── 文件夹选中态 ── */
.folder-card { position: relative; }
.folder-card.selected {
  border-color: rgba(123,127,178,0.55);
  background: rgba(255,255,255,0.92);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 0 0 2px rgba(123,127,178,0.28);
}
.folder-card.selected::before {
  content: ''; position: absolute; inset: 0; z-index: 2;
  pointer-events: none; border-radius: inherit;
  background: rgba(123,127,178,0.14);
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

/* ── 文件夹卡片 ── */
.folder-card {
  background: color-mix(in srgb, var(--fd-color, #8888a0) 6%, rgba(255,255,255,0.82));
  border: 1px solid color-mix(in srgb, var(--fd-color, #8888a0) 14%, rgba(255,255,255,0.92));
  border-radius: 14px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 1px 5px rgba(80,90,110,0.06);
  min-height: 122px;
}
.folder-card:hover {
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 7px 22px rgba(80,90,110,0.12);
}

.fd-icon-area {
  height: 90px;
  flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  overflow: visible;
}
.fd-big-icon {
  width: 92px; height: 92px;
  color: var(--fd-color, var(--color-primary));
  opacity: 0.58;
  transform: translateY(20px);
  mask-image: linear-gradient(to bottom, black 0%, black 35%, rgba(0,0,0,0.62) 62%, rgba(0,0,0,0.22) 80%, transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, black 0%, black 35%, rgba(0,0,0,0.62) 62%, rgba(0,0,0,0.22) 80%, transparent 100%);
  flex-shrink: 0;
}
.fd-label { padding: 0 13px 13px; }
.fd-name {
  font-size: 11.5px; font-weight: 600; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  line-height: 1.35; padding-bottom: 2px; margin-bottom: -2px;
}
.fd-count {
  font-size: 9px; color: var(--text-secondary); opacity: 0.55; margin-top: 2px;
}
.fd-hover-actions {
  position: absolute; top: 8px; right: 8px; z-index: 2;
  display: flex; gap: 3px; opacity: 0; transition: opacity 0.15s;
}
.folder-card:hover .fd-hover-actions { opacity: 1; }

/* ── 文件卡片 ── */
/* 抬起(:hover 的 transform)/按下(:active)动效来自全局 .hover-card-fx（模板里已加）；
   box-shadow 在这里自己覆盖一份——要保留文件卡自带的内高光(inset)层，跟 .hover-card-fx
   单纯的外阴影不一样，不能直接吃它那份，数值仍照抄项目卡的抬起阴影，保证手感一致。 */
.fc-card {
  background: rgba(255,255,255,0.72);
  border: 1px solid rgba(255,255,255,0.9);
  border-radius: 14px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 1px 5px rgba(80,90,110,0.06);
  min-height: 122px;
}
.fc-card:hover {
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 6px 18px rgba(80,90,110,0.13);
  background: rgba(255,255,255,0.86);
}
.fc-card.selected {
  border-color: rgba(123,127,178,0.55);
  background: rgba(255,255,255,0.92);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 0 0 2px rgba(123,127,178,0.28);
}
/* 选中覆盖层：::before 覆盖整张卡（含图片卡白色标签区），::after 在缩略图上额外叠加 */
.fc-card.selected::before {
  content: ''; position: absolute; inset: 0; z-index: 2;
  pointer-events: none; border-radius: inherit;
  background: rgba(123,127,178,0.14);
}
.fc-card.selected .fc-thumb-area::after,
.fc-card.pre-selected .fc-thumb-area::after {
  content: ''; position: absolute; inset: 0; z-index: 2;
  pointer-events: none;
}
.fc-card.selected .fc-thumb-area::after    { background: rgba(123,127,178,0.28); }
.fc-card.pre-selected .fc-thumb-area::after { background: rgba(123,127,178,0.16); }

/* ext 角标 */
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

/* 图片缩略图 */
.fc-thumb-area {
  position: relative;
  height: 90px;
  flex-shrink: 0;
  overflow: hidden;
  border-radius: 14px 14px 0 0;
  background: rgba(0,0,0,0.05);
  transform: translateZ(0);   /* 去掉常驻 will-change：大量卡片常驻 will-change 会让合成器层预算耗尽、滚动时偶发闪屏（ProjectModal 同款已改） */
  mask-image: linear-gradient(to bottom, black 48%, transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, black 48%, transparent 100%);
}
.fc-thumb {
  position: absolute;
  inset: 0;
  width: 100%; height: 100%;
  object-fit: cover; object-position: center top;
  display: block;
}
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
.fc-has-thumb .fc-label {
  position: relative; z-index: 1;
}
.fc-has-thumb .fc-ext-badge {
  background: rgba(0,0,0,0.32);
  color: rgba(255,255,255,0.92);
}

/* 底部标签 */
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

/* ── 拖动状态 ── */
.fc-card.dragging, .list-row.dragging { opacity: 0.35; cursor: grabbing; }
.folder-card.drag-over {
  background: color-mix(in srgb, var(--fd-color, var(--color-primary)) 12%, rgba(255,255,255,0.9));
  border-color: color-mix(in srgb, var(--fd-color, var(--color-primary)) 55%, rgba(255,255,255,0.6));
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 0 0 2px color-mix(in srgb, var(--fd-color, var(--color-primary)) 30%, transparent);
}
.list-row.folder-row.drag-over {
  background: rgba(123,127,178,0.08);
  outline: 1.5px solid var(--color-primary); outline-offset: -1px;
}

/* ── 幽灵上传卡片 ── */
.fc-ghost {
  position: relative; min-height: 122px; overflow: hidden;
  border-radius: 14px; border: 1.5px dashed rgba(123,127,178,0.35);
  background: rgba(123,127,178,0.04);
  display: flex; flex-direction: column;
  cursor: default; pointer-events: none;
}
.fc-ghost-fill {
  position: absolute; inset: 0; right: auto; height: 100%;
  background: linear-gradient(135deg,
    color-mix(in srgb, var(--fc-color, rgba(123,127,178,1)) 18%, transparent),
    color-mix(in srgb, var(--fc-color, rgba(123,127,178,1)) 10%, transparent));
  transition: width 0.25s ease-out;
}
.fc-ghost .fc-ext-badge { opacity: 0.6; }
.fc-ghost .fc-icon-area { opacity: 0.35; }
.fc-ghost .fc-label { opacity: 0.75; }
.fc-ghost-meta { font-size: 9px; font-weight: 600; color: var(--fc-color, var(--color-primary)); }
.fc-ghost.error { border-color: rgba(200,90,90,0.4); background: rgba(200,90,90,0.04); }
.fc-ghost.error .fc-ghost-fill { background: rgba(200,90,90,0.12); width: 100% !important; }
.fc-ghost.error .fc-ghost-meta { color: rgba(200,90,90,0.85); }

/* 幽灵上传行 */
.fc-ghost-row {
  position: relative; overflow: hidden;
  border-radius: var(--radius-sm);
  border: 1px solid rgba(123,127,178,0.2) !important;
  background: rgba(123,127,178,0.03) !important;
  pointer-events: none; cursor: default;
}
.fc-ghost-row .fc-ghost-fill {
  position: absolute; inset: 0; right: auto; height: 100%;
  background: rgba(123,127,178,0.08);
  transition: width 0.25s ease-out;
}
.fc-ghost-row .lr-name-cell,
.fc-ghost-row .lr-text,
.fc-ghost-row .lr-type-cell { opacity: 0.6; }
.fc-ghost-row.error { border-color: rgba(200,90,90,0.3) !important; }
.fc-ghost-row.error .fc-ghost-fill { background: rgba(200,90,90,0.1); width: 100% !important; }

.fc-upload {
  border: 1.5px dashed rgba(0,0,0,0.09); border-radius: 14px;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 7px;
  color: var(--text-secondary);
  cursor: pointer; background: rgba(255,255,255,0.2); transition: all 0.18s;
  overflow: hidden; min-height: 130px;
}
.fc-upload:hover { border-color: rgba(123,127,178,0.45); color: var(--color-primary); background: rgba(123,127,178,0.04); }
.fc-upload-text { font-size: 10px; font-weight: 600; }

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
/* ── 右键菜单 ── */
.fc-card.cut, .list-row.cut { opacity: 0.45; }
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
