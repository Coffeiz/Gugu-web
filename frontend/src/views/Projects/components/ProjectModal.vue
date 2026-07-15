<template>
  <BaseModal :show="!!project" width="1060px" height="780px" @close="onModalClose">
      <div class="modal" :class="{ 'stages-expanded': stagesExpanded, 'info-expanded': infoExpanded, 'pm-switching': pmSwitching }">
        <!-- 悬浮操作按钮：文件多选模式下让位给 .pm-selection-bar（同在右下角，多选栏内容多时会重叠，
             且两边都有删除按钮离太近容易误触），多选栏自己有取消/删除，先隐藏这组项目级按钮 -->
        <div v-if="!pmInSelectionMode" class="float-actions">
          <button class="save-float-btn" @click="$emit('close')" title="保存并关闭">
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

          <!-- 标题 -->
          <div class="proj-header">
            <div class="header-main">
              <button class="status-ball" :class="'sb-' + localStatus" @click.stop="cycleStatus"
                :title="projectStore.kanbanColumns.find(c => c.key === localStatus)?.label ?? localStatus"></button>
              <input
                ref="nameInputRef"
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

            <div class="info-block">
            <div class="section">
              <label class="section-label">客户 / 委托方</label>
              <input class="field-input" v-model="localClient" placeholder="客户名称（选填）" />
            </div>

            <hr class="col-divider" />

            <div class="section">
              <label class="section-label">项目周期</label>
              <DateSpanPicker
                v-model:startDate="localStartDate"
                v-model:endDate="localDeadline"
                placeholder="选择开始 — 截止日期"
              />
            </div>

            <hr class="col-divider" />

            <div class="section">
              <label class="section-label">项目颜色</label>
              <div class="color-grid">
                <button
                  v-for="c in colorPresets"
                  :key="c"
                  class="color-chip"
                  :class="{ active: localColor === c }"
                  :style="{ background: c }"
                  @click="setColor(c)"
                >
                  <PhCheck v-if="localColor === c" :size="11" weight="bold" style="color:white" />
                </button>
              </div>
            </div>
            </div><!-- /info-block -->

            <hr class="col-divider" />

            <!-- 阶段 -->
            <div class="section stages-section">
              <div class="stages-header">
                <label class="section-label">项目阶段 <span class="label-hint">拖拽排序</span></label>
                <button class="add-stage-btn" @click="addStage">＋ 添加</button>
              </div>
            <div class="stage-flow" ref="stageFlowRef">
              <TransitionGroup name="stage-flip">
              <div
                v-for="(stage, i) in displayStages" :key="stage.key"
                class="stage-node"
                :class="{
                  active: i === activeStageIdx && stage.key !== draggedStageKey,
                  done: i < activeStageIdx && stage.key !== draggedStageKey,
                  locked: lockedStageIndices.has(localStages.findIndex(s => s.key === stage.key)),
                  'stage-dragging': stageDrag.active && stage.key === draggedStageKey,
                  expanded: expandedStages.has(stage.key),
                }"
              >
                <!-- 节点行 -->
                <div class="node-row" @mousedown="editingStage !== stage.key && startStageDrag(i, $event)">
                  <div class="node-circle"
                    :style="i === activeStageIdx && stage.key !== draggedStageKey ? { background: localColor } : {}"
                    @click.stop="!stageDrag.active && setStage(stage.key, i)"
                  >
                    <PhCheck v-if="i < activeStageIdx && stage.key !== draggedStageKey" :size="10" weight="bold" style="color:white" />
                    <span v-else class="node-num">{{ i + 1 }}</span>
                  </div>
                  <div class="node-body">
                    <input
                      v-if="editingStage === stage.key"
                      v-model="stage.label"
                      class="stage-input"
                      @blur="saveStages" v-enter="saveStages" @keydown.esc="editingStage = null" @click.stop
                      ref="stageInputRef"
                    />
                    <span v-else class="node-label" @click.stop="startEdit(stage.key)">{{ stage.label }}</span>
                    <span class="todo-count" v-if="stage.todos?.length">{{ stage.todos.filter(t=>t.done).length }}/{{ stage.todos.length }}</span>
                  </div>
                  <button class="del-stage" @click.stop="removeStage(stage.key)">
                    <PhX :size="9" weight="bold" />
                  </button>
                </div>
                <!-- 待办列表 -->
                <TransitionGroup tag="div" name="todo-flip" class="todo-list"
                     @dragover.prevent="todoListDragOver(stage)"
                     @drop="todoDragEnd">
                  <div v-for="(todo, ti) in (stage.todos ?? [])" :key="todo.id" class="todo-item"
                       :class="{ 'todo-ghost': todoDrag && todoDrag.stageKey === stage.key && todoDrag.index === ti }"
                       :draggable="editingTodo !== todo.id"
                       @dragstart="todoDragStart(stage, ti)"
                       @dragend="todoDragEnd"
                       @dragover.prevent.stop="todoDragOver(stage, ti, $event)">
                    <button class="todo-check" :class="{ checked: todo.done }" @click.stop="toggleTodo(todo)">
                      <PhCheck v-if="todo.done" :size="9" weight="bold" />
                    </button>
                    <input
                      v-if="editingTodo === todo.id"
                      :class="['todo-input', `todo-input-${stage.key}`]"
                      :data-tid="todo.id"
                      v-model="todo.text"
                      :title="todo.text"
                      :style="todo.done ? { textDecoration: 'line-through', opacity: 0.45 } : {}"
                      placeholder="待办事项"
                      @blur="editingTodo = null; saveStages()"
                      v-enter.prevent="() => (editingTodo = null, saveStages())"
                      @keydown.esc="editingTodo = null"
                      @keydown.backspace="!todo.text && removeTodo(stage, todo.id)"
                    />
                    <span
                      v-else class="todo-name"
                      :style="todo.done ? { textDecoration: 'line-through', opacity: 0.45 } : {}"
                      @click.stop="startEditTodo(todo.id)"
                    >{{ todo.text || '待办事项' }}</span>
                    <button class="todo-del" @click.stop="removeTodo(stage, todo.id)"><PhX :size="8" weight="bold" /></button>
                  </div>
                  <button key="todo-add" class="todo-add-btn" @click.stop="addTodo(stage)">＋ 添加待办</button>
                </TransitionGroup>
                <div v-if="i < displayStages.length - 1" class="node-line"></div>
              </div>
              </TransitionGroup>
            </div>

            <!-- 拖拽虚影（圆圈 + 文字） -->
            <Teleport to="body">
              <div v-if="stageDrag.active" class="stage-drag-ghost-full"
                :style="{ left: stageDrag.ghostX + 'px', top: stageDrag.ghostY + 'px', width: stageDrag.ghostWidth + 'px' }">
                <span class="node-label">{{ stageDrag.ghostLabel }}</span>
                <div v-if="stageDrag.ghostTodos.length" class="ghost-todos">
                  <div v-for="t in stageDrag.ghostTodos" :key="t.id" class="ghost-todo" :class="{ done: t.done }">{{ t.text || '待办事项' }}</div>
                </div>
              </div>
            </Teleport>
          </div>

          </div><!-- /left-content -->
        </div>

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
            <nav class="file-breadcrumb">
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
            </nav>
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
            <div class="sort-selector" @click.stop>
              <button ref="pmSortBtnRef" class="sort-btn" @click.stop="openPmSortMenu">
                <PhSortAscending :size="13" weight="bold" />
                {{ PM_SORT_OPTIONS.find(o => o.key === pmSortKey)?.label }}
                <svg class="sort-dir-icon" :class="{ desc: pmSortDir === 'desc' }" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                  <path d="M5 2v6M2 5l3-3 3 3"/>
                </svg>
              </button>
              <!-- 与右键菜单同源：Teleport 到 body，backdrop-filter 才能正确生效 -->
              <ContextMenu :show="pmSortMenuOpen" :x="pmSortMenuPos.x" :y="pmSortMenuPos.y" @close="pmSortMenuOpen = false">
                <button v-for="opt in PM_SORT_OPTIONS" :key="opt.key"
                  class="ctx-item popup-menu-item sort-menu-item" :class="{ active: pmSortKey === opt.key }"
                  @click="onPmSortSelect(opt.key)">
                  {{ opt.label }}
                  <svg v-if="pmSortKey === opt.key" class="sort-check" :class="{ desc: pmSortDir === 'desc' }" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                    <path d="M5 2v6M2 5l3-3 3 3"/>
                  </svg>
                </button>
              </ContextMenu>
            </div>
            <button class="close-btn" @click="$emit('close')">
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
                <div v-for="folder in sortedCurrentFolders" :key="folder.id"
                  class="folder-card" :style="{ '--fd-color': accentColor }"
                  :class="{ 'drag-over': pmDragOverFolderId === folder.id, selected: pmSelectedFolderIds.has(folder.id), 'pre-selected': pmPreviewFolderIds.has(folder.id) }"
                  :data-pm-folder-id="folder.id"
                  @click.stop="onPmFolderClick(folder, $event)"
                  @contextmenu.prevent.stop="openPmCtx('folder', folder, $event)"
                  @pointerdown="onPmFolderPointerDown(folder, $event)">
                  <Transition name="sel-cb">
                    <div v-if="pmInSelectionMode" class="sel-checkbox" :class="{ checked: pmSelectedFolderIds.has(folder.id) }">
                      <PhCheck v-if="pmSelectedFolderIds.has(folder.id)" :size="10" weight="bold" style="color:white" />
                    </div>
                  </Transition>
                  <div class="fd-icon-area">
                    <svg class="fd-big-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>
                    </svg>
                  </div>
                  <div class="fd-hover-actions" v-show="!pmInSelectionMode">
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
                  </div>
                  <div class="fd-label">
                    <div class="fd-name" :title="folder.name">
                      <span v-if="renamingFolderId === folder.id" class="rename-sizer" @click.stop>
                        <span class="rename-ghost">{{ folderRenameText || ' ' }}</span>
                        <input class="rename-input-inline" v-model="folderRenameText"
                          v-enter="commitFolderRename" @keydown.esc="cancelFolderRename" @blur="commitFolderRename" @focus="($event.target as HTMLInputElement).select()" />
                      </span>
                      <template v-else>{{ folder.name }}</template>
                    </div>
                    <div class="fd-count">{{ pmFolderCount(folder.id) }} 个文件</div>
                  </div>
                </div>
                <!-- 文件卡片（当前层） -->
                <div v-for="file in sortedCurrentFiles" :key="file.id"
                  class="fc-card" :style="{ '--fc-color': fileIconColor(file.ext) }"
                  :class="{ selected: pmSelectedFileIds.has(file.id), 'pre-selected': pmPreviewFileIds.has(file.id), dragging: pmDraggingFileIds.has(file.id), cut: pmCbStore.type === 'cut' && pmCbStore.fileIds.includes(file.id), 'fc-has-thumb': isPmImageExt(file.ext) }"
                  :data-pm-file-id="file.id"
                  @contextmenu.prevent.stop="openPmCtx('file', file, $event)"
                  @click.stop="pmHandleFileClick(file, $event)"
                  @pointerdown="onPmFilePointerDown(file, $event)">
                  <Transition name="sel-cb">
                    <div v-if="pmInSelectionMode" class="sel-checkbox" :class="{ checked: pmSelectedFileIds.has(file.id) }">
                      <PhCheck v-if="pmSelectedFileIds.has(file.id)" :size="10" weight="bold" style="color:white" />
                    </div>
                  </Transition>
                  <span class="fc-ext-badge" :style="{ color: fileIconColor(file.ext), background: fileIconColor(file.ext) + '18' }">{{ file.ext }}</span>
                  <div class="fc-hover-actions" v-show="!pmInSelectionMode">
                    <button class="file-card-btn" :title="renamingFileId === file.id ? '确认' : '重命名'"
                      @mousedown.prevent @click.stop="renamingFileId === file.id ? commitRename() : startRename(file)">
                      <PhCheck v-if="renamingFileId === file.id" :size="10" weight="bold" />
                      <PhPencilSimple v-else :size="10" weight="bold" />
                    </button>
                    <button class="file-card-btn" title="下载" @click.stop="downloadFile(file)"><PhDownloadSimple :size="10" weight="bold" /></button>
                    <button class="file-card-btn del" title="删除" @click.stop="deleteFile(file)"><PhTrash :size="10" weight="bold" /></button>
                  </div>
                  <div v-if="isPmImageExt(file.ext)" class="fc-thumb-area">
                    <img class="fc-thumb fc-thumb-tiny" v-lazy-src="{ id: file.id, size: 'tiny' }" decoding="async" draggable="false" alt="" />
                    <img class="fc-thumb fc-thumb-full" v-lazy-src="{ id: file.id, size: 'card' }"
                      :class="{ 'fc-loaded': thumbLoadedIds.has(file.id) }"
                      decoding="async" draggable="false" alt=""
                      @load="thumbLoadedIds.add(file.id)"
                      @error="($event.target as HTMLElement).style.display='none'" />
                    <div class="fc-thumb-fade"></div>
                  </div>
                  <div v-else class="fc-icon-area">
                    <svg class="fc-big-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
                      <template v-if="fileExtCategory(file.ext) === 'image'">
                        <rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21,15 16,10 5,21"/>
                      </template>
                      <template v-else-if="fileExtCategory(file.ext) === 'video'">
                        <rect x="2" y="4" width="20" height="16" rx="2.5"/><polygon points="10,9 16,12 10,15" fill="currentColor" stroke="none"/>
                      </template>
                      <template v-else-if="fileExtCategory(file.ext) === 'audio'">
                        <path d="M9 18V6l12-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
                      </template>
                      <template v-else-if="fileExtCategory(file.ext) === 'sheet'">
                        <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>
                      </template>
                      <template v-else-if="fileExtCategory(file.ext) === 'slide'">
                        <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
                        <rect x="6" y="6" width="5" height="4" rx="1"/><path d="M14 7h4M14 10h4"/>
                      </template>
                      <template v-else-if="fileExtCategory(file.ext) === 'archive'">
                        <path d="M21 8l-4-4H7a2 2 0 00-2 2v16a2 2 0 002 2h14a2 2 0 002-2V8z"/><path d="M17 4v4h4"/><path d="M12 11v6M9 14h6"/>
                      </template>
                      <template v-else-if="fileExtCategory(file.ext) === 'code'">
                        <polyline points="16,18 22,12 16,6"/><polyline points="8,6 2,12 8,18"/>
                      </template>
                      <template v-else>
                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/>
                        <line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/>
                      </template>
                    </svg>
                  </div>
                  <div class="fc-label">
                    <div class="fc-name" :title="file.displayName">
                      <span v-if="renamingFileId === file.id" class="rename-sizer" @click.stop>
                        <span class="rename-ghost">{{ renameText || ' ' }}</span>
                        <input class="rename-input-inline" v-model="renameText"
                          v-enter="commitRename" @keydown.esc="cancelRename" @blur="commitRename" @focus="($event.target as HTMLInputElement).select()" />
                      </span>
                      <template v-else>{{ file.displayName }}</template>
                    </div>
                    <div class="fc-meta">{{ file.stageName ? file.stageName + ' · ' : '' }}{{ file.size }}</div>
                  </div>
                </div>
                <!-- 幽灵上传卡片：单文件 / 文件夹（拖入文件夹时汇总一张） -->
                <div v-for="g in uploadingItems" :key="g.uid"
                  class="fc-ghost" :class="{ error: g.error, 'fc-ghost-folder': g.isFolder }"
                  :style="{ '--fc-color': g.isFolder ? '#8a8fa8' : fileIconColor(g.ext) }">
                  <div class="fc-ghost-fill" :style="{ width: g.progress + '%' }"></div>
                  <span v-if="!g.isFolder" class="fc-ext-badge" :style="{ color: fileIconColor(g.ext), background: fileIconColor(g.ext) + '18' }">{{ g.ext || '—' }}</span>
                  <div class="fc-icon-area">
                    <svg class="fc-big-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
                      <template v-if="g.isFolder">
                        <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>
                      </template>
                      <template v-else-if="fileExtCategory(g.ext) === 'image'">
                        <rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21,15 16,10 5,21"/>
                      </template>
                      <template v-else-if="fileExtCategory(g.ext) === 'video'">
                        <rect x="2" y="4" width="20" height="16" rx="2.5"/><polygon points="10,9 16,12 10,15" fill="currentColor" stroke="none"/>
                      </template>
                      <template v-else-if="fileExtCategory(g.ext) === 'audio'">
                        <path d="M9 18V6l12-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
                      </template>
                      <template v-else-if="fileExtCategory(g.ext) === 'sheet'">
                        <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>
                      </template>
                      <template v-else-if="fileExtCategory(g.ext) === 'slide'">
                        <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
                        <rect x="6" y="6" width="5" height="4" rx="1"/><path d="M14 7h4M14 10h4"/>
                      </template>
                      <template v-else-if="fileExtCategory(g.ext) === 'archive'">
                        <path d="M21 8l-4-4H7a2 2 0 00-2 2v16a2 2 0 002 2h14a2 2 0 002-2V8z"/><path d="M17 4v4h4"/><path d="M12 11v6M9 14h6"/>
                      </template>
                      <template v-else-if="fileExtCategory(g.ext) === 'code'">
                        <polyline points="16,18 22,12 16,6"/><polyline points="8,6 2,12 8,18"/>
                      </template>
                      <template v-else>
                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/>
                        <line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/>
                      </template>
                    </svg>
                  </div>
                  <div class="fc-label">
                    <div class="fc-name" :title="g.name">{{ g.name }}</div>
                    <div class="fc-meta fc-ghost-meta">
                      <template v-if="g.isFolder">
                        <template v-if="g.error">{{ (g.done ?? 0) - (g.failed ?? 0) }}/{{ g.total }}（{{ g.failed }} 个失败）</template>
                        <template v-else>{{ g.done }}/{{ g.total }}</template>
                      </template>
                      <template v-else-if="g.error">上传失败</template>
                      <template v-else>{{ g.progress }}%</template>
                    </div>
                  </div>
                </div>
                <!-- 上传卡片 -->
                <label class="fc-upload" :class="{ dragging }"
                  @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="handleFileDrop">
                  <PhUploadSimple :size="16" weight="bold" />
                  <span>上传文件</span>
                  <input type="file" hidden multiple @change="handleFileInput" />
                </label>
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
                <div v-for="g in uploadingItems" :key="g.uid"
                  class="list-row fc-ghost-row" :class="{ error: g.error }">
                  <div class="fc-ghost-fill" :style="{ width: g.progress + '%' }"></div>
                  <span class="lr-name-cell">
                    <span v-if="!g.isFolder" class="lr-ext" :style="{ color: fileIconColor(g.ext), background: fileIconColor(g.ext) + '18' }">{{ g.ext || '—' }}</span>
                    <span class="lr-filename">{{ g.name }}</span>
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
                <!-- 上传行 -->
                <label class="list-upload-row" @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="handleFileDrop">
                  <PhUploadSimple :size="13" weight="bold" />
                  上传文件 <input type="file" hidden multiple @change="handleFileInput" />
                </label>
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
      </div>
  </BaseModal>

  <!-- 右键菜单 -->
  <ContextMenu :show="pmCtx.visible" :x="pmCtx.x" :y="pmCtx.y" @close="pmCtx.visible = false">
    <template v-if="pmCtx.type === 'file' || pmCtx.type === 'multi-file'">
      <button v-if="pmCtx.type === 'file'" class="ctx-item popup-menu-item" @click="pmCtxInfo">
        <PhInfo :size="13" weight="bold" />
        详细信息
      </button>
      <button class="ctx-item popup-menu-item" @click="pmCtxDownload">
        <PhDownloadSimple :size="13" weight="bold" />
        下载
      </button>
      <button v-if="pmCtx.type === 'file'" class="ctx-item popup-menu-item" @click="pmCtxRename">
        <PhPencilSimple :size="13" weight="bold" />
        重命名
      </button>
      <div class="popup-menu-sep"></div>
      <button class="ctx-item popup-menu-item" @click="pmCtxCut">
        <PhScissors :size="13" weight="bold" />
        剪切 <span class="popup-menu-shortcut">{{ modKey }}+X</span>
      </button>
      <button class="ctx-item popup-menu-item" @click="pmCtxCopy">
        <PhCopy :size="13" weight="bold" />
        复制 <span class="popup-menu-shortcut">{{ modKey }}+C</span>
      </button>
      <div class="popup-menu-sep"></div>
      <button class="ctx-item popup-menu-item danger" @click="pmCtxDelete">
        <PhTrash :size="13" weight="bold" />
        移到回收站
      </button>
    </template>

    <template v-else-if="pmCtx.type === 'folder'">
      <button class="ctx-item popup-menu-item" @click="pmCtxDownloadFolder">
        <PhDownloadSimple :size="13" weight="bold" />
        下载为 ZIP
      </button>
      <button class="ctx-item popup-menu-item" @click="pmCtxRenameFolder">
        <PhPencilSimple :size="13" weight="bold" />
        重命名
      </button>
      <button class="ctx-item popup-menu-item" @click="pmCtxCutFolder">
        <PhScissors :size="13" weight="bold" />
        剪切 <span class="popup-menu-shortcut">{{ modKey }}+X</span>
      </button>
      <div class="popup-menu-sep"></div>
      <button class="ctx-item popup-menu-item danger" @click="pmCtxDeleteFolder">
        <PhTrash :size="13" weight="bold" />
        删除
      </button>
    </template>

    <template v-else-if="pmCtx.type === 'empty'">
      <button class="ctx-item popup-menu-item" @click="pmCtx.visible = false; showNewFolder = true">
        <PhFolderPlus :size="13" weight="bold" />
        新建文件夹
      </button>
      <div class="popup-menu-sep"></div>
      <button v-if="pmCbStore.hasContent()" class="ctx-item popup-menu-item" @click="pmCtxPaste">
        <PhClipboardText :size="13" weight="bold" />
        粘贴 <span class="popup-menu-shortcut">{{ modKey }}+V</span>
      </button>
      <button v-else class="ctx-item popup-menu-item" disabled style="opacity:.4;cursor:default">
        <PhClipboardText :size="13" weight="bold" />
        剪贴板为空
      </button>
    </template>
  </ContextMenu>

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
import { cloneProjectStages, firstIncompleteStageIdx, transitionProjectStage } from '@/utils/projectStages'
import { useFilesCacheStore, type FileMeta, type FolderMeta } from '@/stores/filesCache'
import type { Project, ProjectStage, ProjectTodo } from '@/types/project'
import { filesApi, foldersApi, projectsApi, uploadWithProgress } from '@/services/api'
import { thumbLoadedIds, clearThumbCache } from '@/composables/useThumbCache'
import { vLazyThumb as vLazySrc } from '@/composables/useLazyThumb'
import { isImageExt as isPmImageExt, fileExtCategory, fileIconColor } from '@/utils/fileTypes'
import { splitName } from '@/utils/fileParse'
import { useSorting } from '@/composables/useSorting'
import { useUploadQueue } from '@/composables/useUploadQueue'
import { readDroppedEntries, filesToItems, uploadFilesWithFolders, checkUploadConflicts } from '@/composables/useFileUpload'
import { useBoxSelection } from '@/composables/useBoxSelection'
import { useFileDragDrop } from '@/composables/useFileDragDrop'
import { fireHint } from '@/composables/useOnboarding'
import DatePicker from '@/components/common/DatePicker.vue'
import DateSpanPicker from '@/components/common/DateSpanPicker.vue'
import BaseModal from '@/components/common/BaseModal.vue'
import UploadConflictDialog, { type ConflictItem, type ConflictDecision } from '@/components/common/UploadConflictDialog.vue'
import type { UploadItem } from '@/composables/useFileUpload'
import { usePreviewStore, isPreviewable } from '@/stores/preview'
import {
  PhFolder, PhArrowLeft, PhArrowRight, PhCaretLeft, PhCaretRight, PhCaretDown, PhSortAscending, PhSquaresFour, PhList,
  PhCheckSquare, PhFolderPlus, PhUploadSimple, PhPencilSimple,
  PhDownloadSimple, PhScissors, PhCopy, PhClipboardText, PhX, PhCheck,
  PhInfo, PhWarningCircle, PhDotsThree, PhTrash, PhArchive,
} from '@phosphor-icons/vue'
import ContextMenu   from '@/components/ContextMenu.vue'
import FileInfoPopup from '@/components/common/FileInfoPopup.vue'
import FileSelectionToolbar from '@/components/common/FileSelectionToolbar.vue'
import FilePasteButton from '@/components/common/FilePasteButton.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import FileBrowserGrid from '@/components/common/FileBrowserGrid.vue'
import FileBrowserList from '@/components/common/FileBrowserList.vue'
import { useClipboardStore } from '@/stores/clipboard'
import { useLiveStore } from '@/stores/live'
import { usePreferencesStore } from '@/stores/preferences'
import { parseFolderId } from '@/utils/folderKeys'
import { useFileSelection } from '@/composables/files/useFileSelection'
import { sortFileProjection } from '@/composables/files/useFileProjection'
import { useFolderNavigation } from '@/composables/files/useFolderNavigation'

const props = defineProps({ project: { type: Object as PropType<Project | null>, default: null } })
const emit = defineEmits(['close'])
function onModalClose() { emit('close'); pmSortMenuOpen.value = false }

// e.message 兜底：console.error 里统一格式化未知类型的异常，跟 stores/projects.ts 的 errMsg 同一约定。
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const projectStore     = useProjectStore()
const fileCacheStore   = useFilesCacheStore()
const liveStore        = useLiveStore()
const prefsStore       = usePreferencesStore()
const editingStage     = ref<string | null>(null)
const stageInputRef    = ref<HTMLInputElement[] | null>(null)
const stageFlowRef     = ref<HTMLElement | null>(null)
interface StageDragState {
  active: boolean
  fromIdx: number
  overIdx: number
  ghostX: number
  ghostY: number
  ghostLabel: string
  ghostNum: number
  ghostIsActive: boolean
  ghostIsDone: boolean
  ghostWidth: number
  grabOffsetX: number
  grabOffsetY: number
  ghostTodos: ProjectTodo[]
}
const stageDrag = reactive<StageDragState>({
  active: false, fromIdx: -1, overIdx: -1,
  ghostX: 0, ghostY: 0, ghostLabel: '',
  ghostNum: 1, ghostIsActive: false, ghostIsDone: false,
  ghostWidth: 200, grabOffsetX: 0, grabOffsetY: 0, ghostTodos: [],
})
const dragging         = ref(false)
const pmDragCounter    = ref(0)
const pmIsDragging     = computed(() => pmDragCounter.value > 0)
// 未在模板中实际挂到 DatePicker 实例上（当前用的是 DateSpanPicker），保留原有形状仅补类型。
const startPickerRef    = ref<{ openPicker: () => void; closePicker: () => void } | null>(null)
const deadlinePickerRef = ref<{ openPicker: () => void; closePicker: () => void } | null>(null)
const editingName      = ref(false)
const localName        = ref('')
const nameInputRef     = ref<HTMLInputElement | null>(null)

const localStages      = ref<ProjectStage[]>([])
const expandedStages   = ref(new Set<string>())
let _syncingFromStore  = false   // 防止 store→localStages 同步触发 saveTodos
const localStartDate = ref('')
const localDeadline  = ref('')
const localClient    = ref('')
const localColor        = ref('')
const localCurrentStage = ref('')
const localStatus       = ref('')
const fileViewMode   = ref<'grid' | 'list'>('grid')
// Tier 3：文件/文件夹数据统一由全局 filesCache store 提供（currentFiles/currentFolders 从它派生），
// 不再自持 projectFiles/projectFolders/folderFilesMap/subFolderMap 本地缓存。
const openFolders = ref(new Set<number>())
const {
  folderStack,
  canGoBack: pmCanGoBack,
  canGoForward: pmCanGoForward,
  enterFolder: pmEnterFolder,
  navigateTo: pmNavigateTo,
  goBack: pmGoBack,
  goForward: pmGoForward,
  pruneHistoryForFolders: prunePmHistoryForFolder,
  reset: resetPmNavigation,
} = useFolderNavigation()
// Tier 3：当前层的文件/文件夹直接从全局 filesCache store 派生（单一数据源，不再自持
// projectFiles/folderFilesMap/subFolderMap/projectFolders 本地缓存）。任何页面/SSE 改了 store，
// 这里自动更新，也不会再有「两套缓存不一致」的 stale。根目录用项目根 getter，子目录用文件夹 getter。
const currentFolders = computed(() => {
  const pid = props.project?.id ?? -1
  if (!folderStack.value.length) return fileCacheStore.getProjectRootFolders(pid)
  const parentId = folderStack.value[folderStack.value.length - 1].id
  return fileCacheStore.getSubFolders(parentId)
})

const currentFiles = computed(() => {
  const pid = props.project?.id ?? -1
  if (!folderStack.value.length) return fileCacheStore.getProjectRootFiles(pid)
  const folderId = folderStack.value[folderStack.value.length - 1].id
  return fileCacheStore.getFolderFiles(folderId)
})

// 文件夹卡片计数徽标：从 store 现算直属文件数（永远准，不用手工增减 fileCount）
function pmFolderCount(folderId: number) {
  return fileCacheStore.getFolderFiles(folderId).length
}
// tiny 已由 v-lazy-src 视口门控，不再全量预热

// 兼容旧模板引用（进入文件夹后的文件）
const currentFolder = computed(() =>
  folderStack.value.length ? folderStack.value[folderStack.value.length - 1] : null
)
const currentFolderFiles = computed(() => currentFiles.value)

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

// 项目文件总数：根文件 + 本项目所有文件夹（含嵌套）里的文件。按文件夹归属数，不依赖 file.projectId
// （历史文件的 project_id 可能为 null，只靠 folder_id 关联），从 store 现算。
const totalFileCount = computed(() => {
  const pid = props.project?.id ?? -1
  let n = fileCacheStore.getProjectRootFiles(pid).length
  for (const f of fileCacheStore.allFolders) {
    if (f.projectId === pid) n += fileCacheStore.getFolderFiles(f.id).length
  }
  return n
})

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
  toggleFileSelect: toggleFileSelectPm,
  toggleFolderSelect: _toggleFolderSelPm,
} = useBoxSelection(pmGridRef, {
  fileAttr: 'data-pm-file-id',
  folderAttr: 'data-pm-folder-id',
  excludeSelector: 'button, input, .folder-card, .fc-card, .fc-upload, label',
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
  pmSelectionModeForced.value || pmSelectedFileIds.value.size > 0 || pmSelectedFolderIds.value.size > 0
)

const pmFlatSelectableItems = computed(() => [
  ...sortedCurrentFolders.value.map(f => ({ type: 'folder', id: f.id })),
  ...sortedCurrentFiles.value.map(f => ({ type: 'file',   id: f.id })),
])

function _pmShiftSelect(type: 'folder' | 'file', id: number) {
  const flat = pmFlatSelectableItems.value
  const idx = flat.findIndex(i => i.type === type && i.id === id)
  if (idx < 0 || pmLastAnchorIndex.value < 0) return false
  const [a, b] = pmLastAnchorIndex.value <= idx
    ? [pmLastAnchorIndex.value, idx]
    : [idx, pmLastAnchorIndex.value]
  const range = flat.slice(a, b + 1)
  pmSelectedFileIds.value   = new Set(range.filter(i => i.type === 'file').map(i => i.id))
  pmSelectedFolderIds.value = new Set(range.filter(i => i.type === 'folder').map(i => i.id))
  return true
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

function toggleFolderSelectPm(folder: FolderMeta) { _toggleFolderSelPm(folder.id) }

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
  const ids = new Set(pmSelectedFileIds.value)
  if (e.ctrlKey || e.metaKey || pmInSelectionMode.value) {
    // 选中模式或 Ctrl/Cmd：toggle
    if (ids.has(file.id)) ids.delete(file.id); else ids.add(file.id)
  } else {
    if (ids.size === 1 && ids.has(file.id) && pmSelectedFolderIds.value.size === 0) ids.clear()
    else { ids.clear(); pmSelectedFolderIds.value = new Set(); ids.add(file.id) }
  }
  pmSelectedFileIds.value = ids
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
    const ids = new Set(pmSelectedFolderIds.value)
    if (ids.has(folder.id)) ids.delete(folder.id); else ids.add(folder.id)
    pmSelectedFolderIds.value = ids
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
      if (f) await filesApi.download(f.id, `${f.displayName}.${f.ext}`)
      return
    }
    // 单个文件夹 → 以文件夹名打包
    if (folderIds.length === 1 && ids.length === 0) {
      const folder = sortedCurrentFolders.value.find(f => f.id === folderIds[0])
      if (folder) await foldersApi.download(folderIds[0], folder.name)
      return
    }
    // 多选 → 以当前目录名打包
    const dirName = currentFolder.value?.name ?? props.project?.name ?? '文件'
    await filesApi.batchDownload(ids, folderIds, `${dirName}.zip`)
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
      ...fids.map(id => filesApi.delete(id)),
      ...dids.map(id => foldersApi.delete(id)),
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
async function movePmFoldersInto(folderIds: (number | string)[], targetFolderId: number | string | null) {
  const nTarget = targetFolderId == null ? null : Number(targetFolderId)
  try {
    const results = await Promise.all(folderIds.map(id =>
      foldersApi.move(Number(id), nTarget, fileCacheStore.getFolder(Number(id))?.version ?? 1, props.project?.id ?? null)))
    results.forEach(f => fileCacheStore.updateFolder(f.id, { parentId: nTarget, projectId: props.project?.id ?? null, version: f.version }))
  } catch (err) { console.error('[ProjectModal] 移动文件夹失败:', errMsg(err)) }
  // 不再重置导航——store 单源，移走的文件夹自动从当前视图消失，用户停在原地即可（老代码重置到根是
  // 全量重拉的副作用，非有意行为）。
}
async function movePmFilesInto(fileIds: (number | string)[], targetFolderId: number | string | null, { droppedOn }: { droppedOn: 'folder' | 'breadcrumb' }) {
  // 必须显式带上 projectId：后端 update_file 未传 project_id 时保留原值，而项目文件夹内文件的
  // project_id 可能为 null（只靠 folder_id 关联）；拖到根不带 projectId 会落到个人库根、项目根查不到。
  void droppedOn
  const projectId = props.project?.id ?? null
  const folderId = targetFolderId == null ? null : Number(targetFolderId)
  try {
    await Promise.all(fileIds.map(id => filesApi.update(Number(id), { folderId, projectId })))
    fileIds.forEach(id => fileCacheStore.updateFile(Number(id), { folderId, projectId }))
  } catch (err) { console.error('[ProjectModal] 移动失败:', errMsg(err)) }
  // 视图/计数都从 store 现算，移走的文件自动消失、目标层自动出现，无需刷新或重置导航（停在原地）。
}

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
const { SORT_OPTIONS: PM_SORT_OPTIONS, sortKey: pmSortKey, sortDir: pmSortDir, sortMenuOpen: pmSortMenuOpen, sortBtnRef: pmSortBtnRef, sortMenuPos: pmSortMenuPos, openSortMenu: openPmSortMenu, onSortSelect: onPmSortSelect } = useSorting()

const sortedCurrentFolders = computed(() => {
  return sortFileProjection(currentFolders.value, pmSortKey.value, pmSortDir.value, {
    name: folder => folder.name, type: folder => folder.name, id: folder => folder.id,
  })
})

const sortedCurrentFiles = computed(() => {
  return sortFileProjection(currentFiles.value, pmSortKey.value, pmSortDir.value, {
    name: file => file.displayName,
    type: file => `${fileExtCategory(file.ext)}:${file.ext ?? ''}`,
    stage: file => file.stageName ?? '',
    createdAt: file => file.createdAt,
    size: file => file.sizeBytes ?? 0,
    id: file => file.id,
  })
})

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
    const created = await foldersApi.create(props.project.id, name, parentId)
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
async function commitRename() {
  const id   = renamingFileId.value
  const name = renameText.value.trim()
  renamingFileId.value = null
  if (!id || !name) return
  try {
    await filesApi.update(id, { displayName: name })
    fileCacheStore.updateFile(id, { displayName: name })
  } catch (e) {
    console.error('[ProjectModal] 重命名失败:', errMsg(e))
  }
}

// ── 删除 ─────────────────────────────────────────────────────────────────────

async function deleteFile(file: FileMeta) {
  try {
    await filesApi.delete(file.id)
    fileCacheStore.removeFile(file.id)
  } catch (e) {
    console.error('[ProjectModal] 删除失败:', errMsg(e))
  }
}

// ── 下载 ─────────────────────────────────────────────────────────────────────

function downloadFile(file: FileMeta) {
  filesApi.download(file.id, file.displayName + '.' + file.ext.toLowerCase())
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
async function commitFolderRename() {
  const id   = renamingFolderId.value
  const name = folderRenameText.value.trim()
  renamingFolderId.value = null
  if (!id || !name) return
  try {
    const version = fileCacheStore.getFolder(id)?.version ?? 1
    const updated = await foldersApi.rename(id, name, version)
    fileCacheStore.updateFolder(id, { name, version: updated.version })
  } catch (e) {
    console.error('[ProjectModal] 文件夹重命名失败:', errMsg(e))
  }
}

function downloadFolderZip(folder: FolderMeta) {
  foldersApi.download(folder.id, folder.name)
}

async function deleteFolderCard(folder: FolderMeta) {
  prunePmHistoryForFolder([folder.id])
  try {
    await foldersApi.delete(folder.id)
    fileCacheStore.removeFolder(folder.id)   // 级联删该文件夹的子文件夹及其文件；视图自动更新
  } catch (e) {
    console.error('[ProjectModal] 删除文件夹失败:', errMsg(e))
  }
}

let initializing = false
const activeStageIdx = ref(-1)
const stageProgress  = ref(0)


// 外部（Agent/IM）修改日期时同步本地状态（project?.id 不变，但日期值变了）
watch(() => props.project?.startDate, (v) => { if (!initializing) localStartDate.value = v ?? '' })
watch(() => props.project?.deadline,  (v) => { if (!initializing) localDeadline.value  = v ?? '' })

watch(() => props.project?.id, async (id) => {
  initializing = true
  localStages.value       = props.project ? props.project.stages.map(s => ({ ...s })) : []
  localName.value         = props.project?.name         ?? ''
  localStartDate.value    = props.project?.startDate    ?? ''
  localDeadline.value     = props.project?.deadline     ?? ''
  localClient.value       = props.project?.client       ?? ''
  localColor.value        = props.project?.color        ?? ''
  localCurrentStage.value = props.project?.currentStage ?? ''
  localStatus.value       = props.project?.status       ?? ''
  recalcStageState()
  editingStage.value   = null
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

// 实时同步阶段/待办：咕咕（web 聊天 / IM）用 set_stages/update_todo/add_todo 等改了阶段后，
// projectStore 会在 rev.projects 上 fetchProjects 刷新；这里监听 store 里本项目 stages 的变化，
// 同步进可编辑副本 localStages。两道保险：① 正在编辑（改阶段名 / 拖拽 / 敲待办输入框）时跳过，
// 不冲掉手头改动；② 与本地一致则不动（避开"自己保存→store 更新"的回环）。
const _storeProject = computed(() => projectStore.projects.find(p => p.id === props.project?.id))
function _editingStageArea() {
  if (editingStage.value || stageDrag.active) return true
  const el = document.activeElement
  return !!(el && el.classList &&
            (el.classList.contains('todo-input') || el.classList.contains('stage-input')))
}
watch(() => _storeProject.value?.stages, (stages) => {
  if (!stages || _editingStageArea()) return
  if (JSON.stringify(stages) === JSON.stringify(localStages.value)) return
  _syncingFromStore = true
  localStages.value       = stages.map(s => ({ ...s, todos: (s.todos || []).map(t => ({ ...t })) }))
  localCurrentStage.value = _storeProject.value?.currentStage ?? localCurrentStage.value
  recalcStageState()
  nextTick(() => { _syncingFromStore = false })
}, { deep: true })

// 跟踪 store 里的 status 变化（如自动完成 / 拖回），实时同步胶囊亮起状态
watch(() => props.project?.status, (status) => {
  if (status !== undefined && status !== localStatus.value) {
    localStatus.value = status
  }
})



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

function onStartDatePicked(v: unknown) {
  startPickerRef.value?.closePicker()
  if (v) setTimeout(() => deadlinePickerRef.value?.openPicker(), 80)
}
watch(localDeadline, v => {
  if (initializing) return
  const id = props.project?.id
  if (!id) return
  projectStore.updateProject(id, { deadline: v || null })
})

const currentStageIndex = computed(() =>
  localStages.value.findIndex(s => s.key === localCurrentStage.value)
)
// 当前阶段所在位置索引（位置固定，拖动重排不改变）

// 被锁定的阶段下标集合：前面阶段 todo 全部手动完成时，该阶段及之前不可退回
const lockedStageIndices = computed(() => {
  const locked = new Set<number>()
  const stages = localStages.value
  const cur = activeStageIdx.value
  for (let target = 0; target < cur; target++) {
    for (let i = target; i < cur; i++) {
      const todos = stages[i].todos ?? []
      if (todos.length > 0 && todos.every(t => t.done && !t.autoCompleted)) {
        locked.add(target); break
      }
    }
  }
  return locked
})

const displayStages = computed(() => {
  if (!stageDrag.active) return localStages.value
  const stages = [...localStages.value]
  const [item] = stages.splice(stageDrag.fromIdx, 1)
  const to = Math.max(0, Math.min(stageDrag.overIdx, stages.length))
  stages.splice(to, 0, item)
  return stages
})
const draggedStageKey = computed(() =>
  stageDrag.active ? localStages.value[stageDrag.fromIdx]?.key : null
)
const displayCurrentStageIndex = computed(() =>
  displayStages.value.findIndex(s => s.key === localCurrentStage.value)
)
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
function recalcStageState() {
  const stages = localStages.value
  const idx = stages.findIndex(s => s.key === localCurrentStage.value)
  activeStageIdx.value = idx
  stageProgress.value = calcProgress(stages, localCurrentStage.value)
}

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

const colorPresets = [
  'linear-gradient(135deg,#c8aa72,#b88060)',
  'linear-gradient(135deg,#8fbe8b,#7ab8a8)',
  'linear-gradient(135deg,#7ab8a8,#7ab8c8)',
  'linear-gradient(135deg,#7ab8c8,#7b7fb2)',
  'linear-gradient(135deg,#5e73b2,#7b7fb2)',
  'linear-gradient(135deg,#7b7fb2,#c4afc8)',
  'linear-gradient(135deg,#c4afc8,#b07090)',
  'linear-gradient(135deg,#be8b8f,#c8aa72)',
]

function startEditName() {
  editingName.value = true
  nextTick(() => nameInputRef.value?.select())
}
function saveName() {
  if (!props.project) return
  const n = localName.value.trim()
  if (!n) {
    localName.value = props.project.name
  } else if (n !== props.project.name) {
    localName.value = n
    projectStore.updateProject(props.project.id, { name: n })
  }
  editingName.value = false
}
function cancelName() {
  if (props.project) localName.value = props.project.name   // esc 还原，blur 时 saveName 视为无改动
  nameInputRef.value?.blur()
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
    progress: stageProgress.value,
    status: localStatus.value as Project['status'],
  }, key, newProgress)
  _syncingFromStore = true
  localStages.value = transition.stages
  localCurrentStage.value = transition.currentStage ?? ''
  localStatus.value = transition.status
  activeStageIdx.value = idx
  stageProgress.value = transition.progress
  nextTick(() => { _syncingFromStore = false })
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
  emit('close')
}

async function handleArchive() {
  if (!props.project) return
  await projectStore.archiveProject(props.project.id)
  emit('close')
}

function startEdit(key: string) {
  editingStage.value = key
  nextTick(() => stageInputRef.value?.[0]?.focus())
}
function saveStages() {
  editingStage.value = null
  if (props.project) projectStore.updateStages(props.project.id, localStages.value)
}

// 待办拖拽：拖名字行重排，可跨阶段移动；编辑态(span→input)不可拖。
// 实时同步——dragenter 即把拖中项 splice 到目标位（其他待办由 TransitionGroup 动画让位），
// 拖完(dragend / drop)才 saveStages 落库。
const todoDrag = ref<{ stageKey: string; index: number } | null>(null)       // 拖动中实时更新（指向被拖项当前所在位）
const editingTodo = ref<string | null>(null)    // 正在编辑文字的待办 id
function startEditTodo(id: string) {
  editingTodo.value = id
  nextTick(() => document.querySelector<HTMLElement>(`[data-tid="${id}"]`)?.focus())
}
function todoDragStart(stage: ProjectStage, ti: number) {
  todoDrag.value = { stageKey: stage.key, index: ti }
}
function _moveTodo(d: { stageKey: string; index: number }, targetStage: ProjectStage, to: number) {
  const src = localStages.value.find(s => s.key === d.stageKey)
  if (!src?.todos) return
  let idx = to
  if (src === targetStage) {
    if (d.index < to) idx--            // 同列表：移除后目标位前移一格
    if (idx === d.index) return         // 没越过中线，不动
  }
  const [moved] = src.todos.splice(d.index, 1)
  if (!moved) return
  if (!targetStage.todos) targetStage.todos = []
  idx = Math.max(0, Math.min(idx, targetStage.todos.length))
  targetStage.todos.splice(idx, 0, moved)
  todoDrag.value = { stageKey: targetStage.key, index: idx }
}
// dragover + 中线判断：指针越过目标待办中线才换位，避免来回横跳
function todoDragOver(stage: ProjectStage, ti: number, e: DragEvent) {
  const d = todoDrag.value
  if (!d) return
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const after = (e.clientY - r.top) > r.height / 2
  _moveTodo(d, stage, after ? ti + 1 : ti)
}
function todoListDragOver(stage: ProjectStage) {   // 空阶段：拖到空白区移入末尾
  const d = todoDrag.value
  if (d && (stage.todos?.length ?? 0) === 0) _moveTodo(d, stage, 0)
}
function todoDragEnd() {
  if (todoDrag.value) { todoDrag.value = null; saveStages() }
}
function addStage() {
  const key = `stage_${Date.now()}`
  localStages.value.push({ key, label: '新阶段', todos: [] })
  saveStages()
  nextTick(() => startEdit(key))
}
function removeStage(key: string) {
  if (localStages.value.length <= 1) return
  localStages.value = localStages.value.filter(s => s.key !== key)
  expandedStages.value.delete(key)
  saveStages()
}

function toggleExpand(key: string) {
  const s = expandedStages.value
  s.has(key) ? s.delete(key) : s.add(key)
  expandedStages.value = new Set(s)
}
function saveTodos() {
  if (!props.project) return
  if (_syncingFromStore) return
  const newProgress = calcProgress(localStages.value, localCurrentStage.value)
  stageProgress.value = newProgress
  projectStore.saveTodos(props.project.id, cloneProjectStages(localStages.value), newProgress)
}
function addTodo(stage: ProjectStage) {
  if (!stage.todos) stage.todos = []
  stage.todos.push({ id: `td_${Date.now()}`, text: '', done: false })
  saveTodos()
  nextTick(() => {
    const inputs = document.querySelectorAll<HTMLElement>(`.todo-input-${stage.key}`)
    inputs[inputs.length - 1]?.focus()
  })
}
function removeTodo(stage: ProjectStage, id: string) {
  stage.todos = (stage.todos ?? []).filter(t => t.id !== id)
  saveTodos()
}
function toggleTodo(todo: ProjectTodo) {
  todo.done = !todo.done
  todo.autoCompleted = false  // 手动操作后清除自动标记，后退时不再还原
  saveTodos()
  if (todo.done) {
    const currIdx = localStages.value.findIndex(s => s.key === localCurrentStage.value)
    // 推进到「第一个未完成阶段」（只前进）：跳过已完成的中间阶段，前置未完成时不动
    const target = firstIncompleteStageIdx(localStages.value)
    if (target > currIdx) {
      setStage(localStages.value[target].key, target)
    }
  }
}

function stageIdxFromY(y: number) {
  if (!stageFlowRef.value) return stageDrag.overIdx
  const nodes = stageFlowRef.value.querySelectorAll('.stage-node')
  let cur = stageDrag.overIdx
  if (cur < 0) cur = 0
  // 增量 + 滞后：overIdx 每次最多移一格，且需指针「明确越过相邻阶段中线」才移——
  // 避免重排后『指针下的阶段变了』导致 overIdx 反复横跳（闭环抖动）。只读相邻两个 rect，也省 reflow。
  if (cur > 0) {
    const prev = nodes[cur - 1]?.getBoundingClientRect()
    if (prev && y < prev.top + prev.height / 2) return cur - 1
  }
  if (cur < nodes.length - 1) {
    const next = nodes[cur + 1]?.getBoundingClientRect()
    if (next && y > next.top + next.height / 2) return cur + 1
  }
  return cur
}

function startStageDrag(fromIdx: number, e: MouseEvent) {
  const startX = e.clientX, startY = e.clientY
  const el = e.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  const grabOffsetX = e.clientX - rect.left
  const grabOffsetY = e.clientY - rect.top
  let activated = false

  const mm = (ev: MouseEvent) => {
    if (!activated) {
      const dx = ev.clientX - startX, dy = ev.clientY - startY
      if (Math.sqrt(dx * dx + dy * dy) < 4) return
      activated = true
      const stage = localStages.value[fromIdx]
      stageDrag.active       = true
      stageDrag.fromIdx      = fromIdx
      stageDrag.overIdx      = fromIdx
      stageDrag.ghostLabel   = stage?.label ?? ''
      stageDrag.ghostTodos   = stage?.todos ?? []   // ghost 带着待办一起悬浮，保持「整个阶段被抓起」的一体感
      stageDrag.ghostNum     = fromIdx + 1
      stageDrag.ghostIsActive = fromIdx === activeStageIdx.value
      stageDrag.ghostIsDone  = fromIdx < activeStageIdx.value
      stageDrag.ghostWidth   = rect.width
      stageDrag.grabOffsetX  = grabOffsetX
      stageDrag.grabOffsetY  = grabOffsetY
      document.body.style.cursor     = 'grabbing'
      document.body.style.userSelect = 'none'
    }
    stageDrag.ghostX  = ev.clientX - stageDrag.grabOffsetX
    stageDrag.ghostY  = ev.clientY - stageDrag.grabOffsetY
    stageDrag.overIdx = stageIdxFromY(ev.clientY)
  }

  const mu = () => {
    document.removeEventListener('mousemove', mm)
    document.removeEventListener('mouseup', mu)
    if (activated) {
      commitStageDrag()  // 先提交，再重置索引
      stageDrag.active = false
      stageDrag.fromIdx = -1
      stageDrag.overIdx = -1
      document.addEventListener('click', ce => ce.stopPropagation(), { capture: true, once: true })
    }
    document.body.style.cursor     = ''
    document.body.style.userSelect = ''
  }

  document.addEventListener('mousemove', mm)
  document.addEventListener('mouseup', mu)
}

function commitStageDrag() {
  const { fromIdx, overIdx } = stageDrag
  if (fromIdx < 0 || fromIdx === overIdx) return
  const stages = JSON.parse(JSON.stringify(localStages.value))
  // 整个阶段对象（label + todos + key）一起搬，和预览 displayStages 一致。
  // key 是稳定身份不随位置变；当前阶段按 key 跟随移动后的阶段（updateStages 不重排 key）。
  const [moved] = stages.splice(fromIdx, 1)
  stages.splice(Math.max(0, Math.min(overIdx, stages.length)), 0, moved)
  localStages.value = stages
  saveStages()
}

const { uploadingItems, createGhost, updateGhostProgress, removeGhost, failGhost, createFolderGhost, bumpFolderGhost } = useUploadQueue()

// items: UploadItem[]（{file, relativePath}）——relativePath 带 "/" 时来自拖入的文件夹，
// 由 uploadFilesWithFolders 按路径建好子文件夹再落到各自正确的 folder_id。
const conflictDialogRef = ref<{ show: (list: ConflictItem[]) => Promise<Map<string, ConflictDecision>> } | null>(null)

async function uploadFiles(items: UploadItem[]) {
  if (!items.length || !props.project) return
  const folder = currentFolder.value
  const baseFolderId = folder?.id ?? null

  // 上传前探测同名冲突（只查直接落在这个文件夹的顶层文件）；有冲突才弹列表式确认，
  // 选「跳过」的文件从这批里剔除，不会真的发上传请求。
  const conflicts = await checkUploadConflicts(items, { space: 'project', projectId: props.project.id, folderId: baseFolderId })
  let decisions = new Map<string, ConflictDecision>()
  if (conflicts.length) {
    decisions = (await conflictDialogRef.value?.show(conflicts)) ?? new Map()
    items = items.filter(it => decisions.get(it.relativePath)?.action !== 'skip')
    if (!items.length) return
  }

  // 按顶层文件夹分组：relativePath 带 "/" 的文件汇总进「文件夹名 · 完成数/总数」一张卡，
  // 不用每个文件各出一张（大部分还落在当前看不见的子文件夹里）
  const folderGhosts = new Map<string, ReturnType<typeof createFolderGhost> | null>()
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
  const pendingTopFolders = new Map<string, FolderMeta>()

  await uploadFilesWithFolders(items, {
    projectId: props.project.id, baseFolderId,
    onFolderCreated: (created) => {
      // 顶层被 ghost 追踪的文件夹（正在当前层显示上传进度）：先攒着，等 ghost 完成再加进 store，
      // 避免卡片跟 ghost 同屏像「两个文件夹」。其余（更深层，当前层看不到）直接加进 store。
      if (folderGhosts.has(created.name) && (created.parentId ?? null) === baseFolderId) {
        pendingTopFolders.set(created.name, created as FolderMeta)
        return
      }
      fileCacheStore.addFolder(created)
    },
    uploadOne: async (file, resolvedFolderId, relativePath) => {
      const top = relativePath.includes('/') ? relativePath.slice(0, relativePath.indexOf('/')) : null
      const folderGhost = top ? folderGhosts.get(top) : null
      const { base: ghostBase, ext: ghostExt } = splitName(file.name)
      const ghost = folderGhost ? null : createGhost(ghostBase, ghostExt.toUpperCase())
      // 这组文件全处理完（不管成功失败）就把攒着的真实文件夹插进可见列表——成功/失败两条
      // 路径都要走，否则「文件夹最后一个文件恰好失败」时永远插不进去
      const settleFolder = (failed: boolean) => {
        if (!folderGhost) return
        bumpFolderGhost(folderGhost, failed)
        if ((folderGhost.done ?? 0) >= (folderGhost.total ?? 0) && top != null && pendingTopFolders.has(top)) {
          fileCacheStore.addFolder(pendingTopFolders.get(top)!)   // ghost 完成，真实文件夹加进 store 换上卡片
          pendingTopFolders.delete(top)
        }
      }
      try {
        const form = new FormData()
        form.append('file', file)
        form.append('space', 'project')
        form.append('project_id', String(props.project!.id))
        if (resolvedFolderId) form.append('folder_id', String(resolvedFolderId))
        const decision = decisions.get(relativePath)
        const overwriteId = decision?.action === 'overwrite' ? decision.existingFileId : null
        if (overwriteId) {
          form.append('on_conflict', 'overwrite')
          form.append('overwrite_file_id', String(overwriteId))
        }
        const created = await uploadWithProgress('/files', form, p => { if (ghost) updateGhostProgress(ghost, p) })
        if (ghost) removeGhost(ghost)
        else settleFolder(false)

        if (overwriteId) {
          // 覆盖：同一个文件 id 换了内容，更新 store 里已有那条，不再插新的；旧缩略图缓存清掉。
          if (created) fileCacheStore.updateFile(overwriteId, created)
          clearThumbCache(overwriteId)
        } else {
          if (created) fileCacheStore.addFile(created)   // 视图（currentFiles）与文件夹计数自动更新
        }
      } catch (e) {
        console.error('[ProjectModal] 上传失败:', errMsg(e))
        if (ghost) failGhost(ghost)
        else settleFolder(true)
      }
    },
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
const pmCtx = ref<{ visible: boolean; x: number; y: number; type: PmCtxType; target: PmCtxTarget | null }>({ visible: false, x: 0, y: 0, type: null, target: null })
const pmInfoPopup = ref<{ show: boolean; file: FileMeta | null; x: number; y: number }>({ show: false, file: null, x: 0, y: 0 })

function openPmCtx(type: 'file' | 'folder' | 'empty', target: PmCtxTarget | null, e: MouseEvent) {
  let resolvedType: PmCtxType = type
  if (type === 'file' && target &&
      (pmSelectedFileIds.value.has(target.id) || pmSelectedFolderIds.value.size > 0) &&
      (pmSelectedFileIds.value.size + pmSelectedFolderIds.value.size) > 1) {
    resolvedType = 'multi-file'
  }
  pmCtx.value = { visible: true, x: e.clientX, y: e.clientY, type: resolvedType, target }
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
    await filesApi.download(target.id, `${target.displayName}.${target.ext}`)
  } else {
    const fids = [...pmSelectedFolderIds.value]
    const dirName = folderStack.value.length
      ? folderStack.value[folderStack.value.length - 1].name
      : (props.project?.name ?? '文件')
    await filesApi.batchDownload(ids, fids, `${dirName}.zip`)
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
  await Promise.all(ids.map(id => filesApi.delete(id)))
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
        Promise.all(fileIds.map(id => filesApi.update(id, { folderId, projectId }))),
        Promise.all(folderIds.map(id =>
          foldersApi.move(id, folderId, fileCacheStore.getFolder(id)?.version ?? 1, projectId))),
      ])
      fileIds.forEach(id => fileCacheStore.updateFile(id, { folderId, projectId }))
      movedFolders.forEach(f => fileCacheStore.updateFolder(f.id, { parentId: folderId, projectId, version: f.version }))
      pmCbStore.clear()
      await fileCacheStore.refresh()
    } else if (pmCbStore.type === 'copy') {
      const created = await Promise.all(fileIds.map(id => filesApi.copy(id, { folderId, projectId })))
      created.forEach(c => { if (c) fileCacheStore.addFile(c) })
      const copiedFolders = await Promise.all(folderIds.map(id => foldersApi.copy(id, folderId, projectId)))
      copiedFolders.forEach(c => fileCacheStore.addFolder(c))
      await fileCacheStore.refresh()
    }
  } catch (e) { console.error('[PM] 粘贴失败:', e) }
  finally { pmPasteBusy.value = false }
}

function onPmKeyDown(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return
  const ctrl = e.ctrlKey || e.metaKey
  if (ctrl && e.key === 'x') {
    const fids = [...pmSelectedFileIds.value]; const dids = [...pmSelectedFolderIds.value]
    if (fids.length || dids.length) { pmCbStore.cut(fids, dids); e.preventDefault() }
  } else if (ctrl && e.key === 'c') {
    const fids = [...pmSelectedFileIds.value]
    if (fids.length) { pmCbStore.copy(fids, []); e.preventDefault() }
  } else if (ctrl && e.key === 'v') {
    if (pmCbStore.hasContent()) { pmCtxPaste(); e.preventDefault() }
  }
}

onMounted(() => document.addEventListener('keydown', onPmKeyDown))
onUnmounted(() => document.removeEventListener('keydown', onPmKeyDown))
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
.stages-section { flex: 1; min-height: 80px; display: flex; flex-direction: column; gap: 0; padding-bottom: 0; }
.stages-header {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;
}
.add-stage-btn {
  background: none; border: none; font-size: 11px; font-weight: 600;
  color: var(--color-primary); cursor: pointer; font-family: var(--font-sans);
  padding: 0; text-transform: none; letter-spacing: 0;
}
.add-stage-btn:hover { opacity: 0.7; }
.stage-flow { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow-y: auto; padding: 2px 11px 4px 8px; margin-right: -3px; }
.stage-flow::-webkit-scrollbar { width: 3px; }
.stage-flow::-webkit-scrollbar-track { background: transparent; }
.stage-flow::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.12); border-radius: 99px; }

.stage-node { display: flex; flex-direction: column; position: relative; cursor: grab; transition: opacity 0.15s; padding: 0 0 0 5px; margin-bottom: 2px; }
.stage-node.stage-dragging { opacity: 0.15; pointer-events: none; transition: none; }   /* 被拖阶段占位瞬间跟随、不参与让位动画；完整保留待办，与跟手 ghost 一致 */

.node-row { display: flex; align-items: center; gap: 8px; padding: 5px 8px 5px 0; }
.node-circle {
  width: 22px; height: 22px; border-radius: 50%;
  border: 1.5px solid rgba(90,95,120,0.35); background: rgba(0,0,0,0.08);
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  cursor: pointer; z-index: 1;
}
.stage-node.done .node-circle { background: var(--color-success); border-color: var(--color-success); }
.stage-node.active .node-circle { border-color: transparent; }
.stage-node.locked .node-circle { cursor: not-allowed; opacity: 0.7; }
.stage-node.locked .node-label  { opacity: 0.6; }
.node-num { font-size: 10px; font-weight: 700; color: #5a5f78; line-height: 1; }
.stage-node.active .node-num { color: #fff; }
.node-body { flex: 1; display: flex; align-items: center; gap: 6px; min-width: 0; }
.node-label { font-size: 13px; color: var(--text-primary); }
.stage-node.done .node-label { color: var(--text-secondary); text-decoration: line-through; }
.stage-node.active .node-label { font-weight: 600; }
.todo-count { font-size: 10px; color: var(--text-secondary); opacity: 0.7; white-space: nowrap; }
.node-expand-btn {
  background: none; border: none; cursor: pointer; color: var(--text-secondary);
  opacity: 0; transition: opacity 0.15s, transform 0.2s; padding: 2px;
  display: flex; align-items: center;
}
.node-expand-btn.open { transform: rotate(180deg); opacity: 0.5 !important; }
.stage-node:hover .node-expand-btn { opacity: 0.4; }
.stage-input {
  font-size: 13px; font-family: var(--font-sans);
  border: 1px solid rgba(123,127,178,0.4); border-radius: 6px; padding: 1px 6px;
  background: rgba(255,255,255,0.5); outline: none; color: var(--text-primary); width: 110px;
  box-shadow: 0 0 0 3px rgba(123,127,178,0.12);
  transition: background 0.15s;
}
.stage-input:hover, .stage-input:focus { background: rgba(255,255,255,0.75); }
.del-stage {
  background: none; border: none; cursor: pointer; color: var(--text-secondary);
  opacity: 0; transition: opacity 0.15s; padding: 2px;
  display: flex; align-items: center; flex-shrink: 0;
}
.stage-node:hover .del-stage { opacity: 0.5; }
.del-stage:hover { opacity: 1 !important; color: var(--color-warning); }
.node-line { display: none; }
/* 待办列表 */
.todo-list { padding: 2px 0 8px 30px; display: flex; flex-direction: column; gap: 3px;
  background-image: linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.06) 20%, rgba(0,0,0,0.06) 80%, transparent 100%);
  background-size: 100% 1px; background-repeat: no-repeat; background-position: center bottom; }
.stage-node:last-child .todo-list { background-image: none; }
.todo-item { display: flex; align-items: flex-start; gap: 6px; min-height: 24px; }
.todo-item + .todo-item { border-top: 1px solid rgba(0,0,0,0.05); }
.todo-check, .todo-del { margin-top: 4px; }   /* 文字换行后多行居中不好看，改顶部对齐；单行时用这个偏移凑回原来的视觉居中 */
.todo-name { flex: 1; min-width: 0; font-size: 12px; line-height: 1.5; color: var(--text-primary); padding: 2px 0; cursor: grab; overflow-wrap: break-word; word-break: break-word; white-space: normal; }
.todo-item:active .todo-name { cursor: grabbing; }
.todo-ghost { opacity: 0.35; }   /* 被拖的那条淡化，让位预览更清楚 */
.todo-check {
  width: 15px; height: 15px; border-radius: 4px; flex-shrink: 0;
  border: 1.5px solid rgba(0,0,0,0.18); background: rgba(255,255,255,0.7);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.15s, border-color 0.15s;
}
.todo-check.checked { background: var(--color-success); border-color: var(--color-success); color: white; }
.todo-input {
  flex: 1; font-size: 12px; font-family: var(--font-sans); color: var(--text-primary);
  border: 1.5px solid transparent; border-radius: 5px;
  background: transparent; outline: none; min-width: 0;
  padding: 0 5px; box-sizing: border-box;
  transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
}
.todo-input:focus {
  background: rgba(255,255,255,0.72);
  border-color: rgba(123,127,178,0.4);
  box-shadow: 0 0 0 3px rgba(123,127,178,0.1);
}
.todo-del {
  background: none; border: none; cursor: pointer; color: var(--text-secondary);
  opacity: 0; transition: opacity 0.15s; padding: 2px; display: flex; align-items: center; flex-shrink: 0;
}
.todo-item:hover .todo-del { opacity: 0.4; }
.todo-del:hover { opacity: 1 !important; color: var(--color-warning); }
.todo-add-btn {
  display: flex; align-items: center; gap: 4px;
  height: 24px; padding: 0 10px; border-radius: 7px;
  border: 1px dashed rgba(0,0,0,0.15); background: rgba(255,255,255,0.62);
  font-size: 11px; font-weight: 500; color: var(--text-secondary);
  cursor: pointer; font-family: var(--font-sans); transition: all 0.15s;
  margin-top: 2px; margin-right: 18px;
}
.todo-add-btn:hover { border-color: var(--color-primary); color: var(--color-primary); background: rgba(255,255,255,0.75); }



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

/* ── 右栏：文件 ── */
.modal-right {
  display: flex; flex-direction: column; min-height: 0;
  flex: 1 1 0; min-width: 0; position: relative;
  background: var(--panel-bg);
  backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98);
}
/* 切换期间临时关掉嵌套 backdrop-filter：它套在 .bm-card 的毛玻璃里、宽度又随动画变，
   会让外层整层毛玻璃在动画起止帧重栅格化 → 整个面板闪屏。切完恢复，静态时毛玻璃照常。 */
.modal.pm-switching .modal-right { backdrop-filter: none; -webkit-backdrop-filter: none; }

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
  /* Mode1：固定卡片宽度（不随比例缩放），只改变列数 */
  grid-template-columns: repeat(auto-fill, 138px);
  gap: 10px;
  align-content: start;
}
/* Mode2（文件区压窄）：卡片缩小，单行正好 4 个，宽高比与 mode1 完全一致（138:122） */
.modal.stages-expanded .file-grid {
  grid-template-columns: repeat(4, 1fr);
}
/* 整卡（fc-card + folder-card）用 aspect-ratio 保持 138:122，flex-column 让缩略图区弹性填充 */
.modal.stages-expanded .fc-card,
.modal.stages-expanded .folder-card {
  min-height: 0;
  aspect-ratio: 138 / 122;
  display: flex;
  flex-direction: column;
}
/* 缩略图/图标区弹性占满卡片扣除 label 后的剩余高度 */
.modal.stages-expanded .fc-thumb-area,
.modal.stages-expanded .fc-icon-area,
.modal.stages-expanded .fd-icon-area {
  flex: 1;
  height: auto;
  min-height: 0;
}
.modal.stages-expanded .fc-big-icon { width: 52px; height: 52px; }
/* 上传按钮与幽灵卡取消固定 min-height，跟随卡片同比例 */
.modal.stages-expanded .fc-upload,
.modal.stages-expanded .fc-ghost { min-height: 0; aspect-ratio: 138 / 122; }
/* 物理拖影克隆体被挂到 body、脱离 .modal.stages-expanded 上下文 → 用克隆标记类补回 mode2 版式，
   否则拖影回落 mode1 的 min-height:122 尺寸，和面板里压扁的卡片对不上（克隆体外框高度由内联 rect 控制）。 */
.fc-card.pm-clone-expanded,
.folder-card.pm-clone-expanded { min-height: 0; display: flex; flex-direction: column; }
.pm-clone-expanded .fc-thumb-area,
.pm-clone-expanded .fc-icon-area,
.pm-clone-expanded .fd-icon-area { flex: 1; height: auto; min-height: 0; }
.pm-clone-expanded .fc-big-icon { width: 52px; height: 52px; }

/* 文件夹卡片 */
.folder-card {
  min-height: 122px; border-radius: 14px;
  background: color-mix(in srgb, var(--fd-color) 6%, rgba(255,255,255,0.82));
  border: 1px solid color-mix(in srgb, var(--fd-color) 14%, rgba(255,255,255,0.92));
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 1px 5px rgba(80,90,110,0.06);
}
.folder-card:hover {
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 7px 22px rgba(80,90,110,0.12);
}
.fd-icon-area { height: 90px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; overflow: visible; }
.fd-big-icon {
  width: 92px; height: 92px;
  color: var(--fd-color); opacity: 0.58;
  transform: translateY(20px);
  mask-image: linear-gradient(to bottom, black 0%, black 35%, rgba(0,0,0,0.62) 62%, rgba(0,0,0,0.22) 80%, transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, black 0%, black 35%, rgba(0,0,0,0.62) 62%, rgba(0,0,0,0.22) 80%, transparent 100%);
  flex-shrink: 0;
}
.fd-label { padding: 0 13px 13px; }
.fd-name { font-size: 11.5px; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.35; padding-bottom: 2px; margin-bottom: -2px; }
.fd-count { font-size: 9px; color: var(--text-secondary); opacity: 0.55; margin-top: 2px; }
.fd-hover-actions {
  position: absolute; top: 8px; right: 8px; z-index: 3;
  display: flex; gap: 3px; opacity: 0; transition: opacity 0.15s;
}
.folder-card:hover .fd-hover-actions { opacity: 1; }

/* 文件卡片 */
.fc-card {
  min-height: 122px; border-radius: 14px;
  background: rgba(255,255,255,0.72);
  border: 1px solid rgba(255,255,255,0.9);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 1px 5px rgba(80,90,110,0.06);
}
.fc-card:hover {
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 7px 22px rgba(80,90,110,0.12);
  background: rgba(255,255,255,0.86);
}
.fc-ext-badge {
  position: absolute; top: 10px; left: 10px;
  font-size: 8px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase;
  border-radius: 4px; padding: 2px 5px; line-height: 1.5; z-index: 1;
}
.fc-icon-area { height: 90px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; overflow: visible; }

.fc-thumb-area {
  position: relative; height: 90px; flex-shrink: 0; overflow: hidden;
  border-radius: 14px 14px 0 0; background: rgba(0,0,0,0.05);
  transform: translateZ(0);   /* 去掉常驻 will-change：大量卡片常驻 will-change 会让合成器层预算耗尽、滚动时偶发闪屏 */
  mask-image: linear-gradient(to bottom, black 48%, transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, black 48%, transparent 100%);
}
.fc-thumb {
  position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: cover; object-position: center top; display: block;
}
.fc-thumb-tiny { filter: blur(10px); transform: scale(1.15); z-index: 1; }
.fc-thumb-full { z-index: 2; opacity: 0; transition: opacity 0.4s ease; }
.fc-thumb-full.fc-loaded { opacity: 1; }
.fc-has-thumb .fc-label { position: relative; z-index: 1; }
.fc-has-thumb .fc-ext-badge { background: rgba(0,0,0,0.32) !important; color: rgba(255,255,255,0.92) !important; }
.fc-big-icon {
  width: 86px; height: 86px;
  color: var(--fc-color); opacity: 0.55;
  transform: translateY(20px);
  mask-image: linear-gradient(to bottom, black 0%, black 35%, rgba(0,0,0,0.62) 62%, rgba(0,0,0,0.22) 80%, transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, black 0%, black 35%, rgba(0,0,0,0.62) 62%, rgba(0,0,0,0.22) 80%, transparent 100%);
  flex-shrink: 0;
}
.fc-label { padding: 0 13px 13px; }
.fc-name {
  font-size: 11.5px; font-weight: 600; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  line-height: 1.35; padding-bottom: 2px; margin-bottom: -2px;
}
.fc-meta { font-size: 9px; color: var(--text-secondary); opacity: 0.55; margin-top: 2px; }

/* 视图切换 & 新建文件夹（header 内） */
.sort-selector { position: relative; }
.sort-btn {
  display: flex; align-items: center; gap: 5px;
  height: 28px; padding: 0 9px; border-radius: 7px; border: none;
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

/* ── 幽灵上传卡片 ── */
.fc-ghost {
  position: relative; min-height: 100px; overflow: hidden;
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
  pointer-events: none;
}
.fc-ghost .fc-ext-badge { opacity: 0.6; }
.fc-ghost .fc-icon-area { opacity: 0.35; }
.fc-ghost .fc-label { opacity: 0.75; }
.fc-ghost-meta { font-size: 10px; font-weight: 600; color: var(--fc-color, var(--color-primary)); }
.fc-ghost.error { border-color: rgba(200,90,90,0.4); background: rgba(200,90,90,0.04); }
.fc-ghost.error .fc-ghost-fill { background: rgba(200,90,90,0.12); width: 100% !important; }
.fc-ghost.error .fc-ghost-meta { color: rgba(200,90,90,0.85); }

/* 幽灵上传行 */
.fc-ghost-row {
  position: relative; overflow: hidden;
  border-color: rgba(123,127,178,0.2) !important;
  background: rgba(123,127,178,0.03) !important;
  pointer-events: none; cursor: default;
}
.fc-ghost-row .fc-ghost-fill {
  position: absolute; inset: 0; right: auto; height: 100%;
  background: rgba(123,127,178,0.08);
  transition: width 0.25s ease-out;
}
.fc-ghost-row .lr-name-cell,
.fc-ghost-row .lr-text { opacity: 0.6; }
.fc-ghost-row.error { border-color: rgba(200,90,90,0.3) !important; }
.fc-ghost-row.error .fc-ghost-fill { background: rgba(200,90,90,0.1); width: 100% !important; }

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

/* ── 拖动 / 选中状态 ── */
.fc-card.dragging, .list-row.dragging { opacity: 0.35; cursor: grabbing; }
.fc-card.selected {
  border-color: rgba(123,127,178,0.55);
  background: rgba(255,255,255,0.92);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 0 0 2px rgba(123,127,178,0.28);
}
/* 选中覆盖层：::before 覆盖整张卡（含图片卡下方的白色文件名标签区），::after 在缩略图上额外叠加（同文件库） */
.fc-card.selected::before {
  content: ''; position: absolute; inset: 0; z-index: 2;
  pointer-events: none; border-radius: inherit;
  background: rgba(123,127,178,0.14);
}
.fc-card.pre-selected { border-color: rgba(123,127,178,0.35); background: rgba(123,127,178,0.05); }
.fc-card.selected .fc-thumb-area::after,
.fc-card.pre-selected .fc-thumb-area::after {
  content: ''; position: absolute; inset: 0; z-index: 2;
  pointer-events: none;
}
.fc-card.selected .fc-thumb-area::after    { background: rgba(123,127,178,0.28); }
.fc-card.pre-selected .fc-thumb-area::after { background: rgba(123,127,178,0.16); }
.folder-card.selected {
  border-color: rgba(123,127,178,0.6);
  background: rgba(123,127,178,0.08);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.85), 0 0 0 2px rgba(123,127,178,0.18);
}
.folder-card.pre-selected {
  border-color: rgba(123,127,178,0.38);
  background: rgba(123,127,178,0.05);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 0 0 1.5px rgba(123,127,178,0.12);
}
.folder-card.drag-over {
  background: color-mix(in srgb, var(--fd-color, var(--color-primary)) 12%, rgba(255,255,255,0.9));
  border-color: color-mix(in srgb, var(--fd-color, var(--color-primary)) 55%, rgba(255,255,255,0.5));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--fd-color, var(--color-primary)) 28%, transparent);
}
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
.list-upload-row {
  display: flex; align-items: center; gap: 7px; padding: 7px 10px;
  font-size: 12px; color: var(--text-secondary); cursor: pointer;
  border-radius: var(--radius-sm); transition: background 0.12s; border: 1px dashed transparent;
}
.list-upload-row:hover { background: rgba(123,127,178,0.05); border-color: rgba(123,127,178,0.3); color: var(--color-primary); }
/* .rename-sizer / .rename-ghost / .rename-input-inline 已提到 global.css（全站重命名输入框共用） */

.fc-upload {
  border: 1.5px dashed rgba(0,0,0,0.09);
  border-radius: 14px; min-height: 130px;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 7px;
  color: var(--text-secondary); font-size: 10px; font-weight: 600;
  cursor: pointer; background: rgba(255,255,255,0.2); transition: all 0.18s;
}
.fc-upload:hover, .fc-upload.dragging {
  border-color: rgba(123,127,178,0.45);
  color: var(--color-primary); background: rgba(123,127,178,0.04);
}

/* ── 动画 ── */
</style>

<style>
.stage-drag-ghost-full {
  position: fixed; z-index: 100000; pointer-events: none;   /* 压顶带:拖拽克隆体不被窗口盖住 */
  display: flex; flex-direction: column; align-items: stretch;
  padding: 6px 12px 8px;
  opacity: 0.85; box-sizing: border-box;   /* 只显示克隆内容，不要底色框/边框/阴影 */
}
.stage-drag-ghost-full .node-label {
  font-size: 13px; color: #1e2028; font-weight: 500;
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.stage-drag-ghost-full .ghost-todos { margin-top: 4px; display: flex; flex-direction: column; gap: 2px; }
.stage-drag-ghost-full .ghost-todo {
  font-size: 12px; color: var(--text-secondary); line-height: 1.4;
  padding-left: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.stage-drag-ghost-full .ghost-todo.done { text-decoration: line-through; opacity: 0.5; }
/* ── 右键菜单 ── */
.fc-card.cut, .list-row.cut { opacity: 0.75; }

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
