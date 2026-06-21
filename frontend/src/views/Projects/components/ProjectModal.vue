<template>
  <BaseModal :show="!!project" width="900px" height="680px" :zIndex="200" @close="onModalClose">
      <div class="modal">
        <!-- 悬浮操作按钮 -->
        <div class="float-actions">
          <button class="save-float-btn" @click="$emit('close')" title="保存并关闭">
            <PhCheck :size="14" weight="bold" />
          </button>
          <button class="del-float-btn" @click="handleDelete" title="删除此项目">
            <PhTrash :size="14" weight="bold" />
          </button>
        </div>

        <!-- 左栏 -->
        <div class="modal-left">

          <!-- 标题 -->
          <div class="proj-header">
            <div class="header-main">
              <input
                v-if="editingName"
                ref="nameInputRef"
                v-model="localName"
                class="header-name-input"
                @blur="saveName"
                @keydown.enter="saveName"
                @keydown.esc="cancelName"
              />
              <div v-else class="header-name" @click="startEditName" title="点击修改名称">{{ localName }}</div>
            </div>
            <div class="header-progress-bar">
              <div class="header-progress-fill" :style="{ width: stageProgress + '%', background: localColor }"></div>
            </div>
          </div>

          <!-- 可滚动内容区 -->
          <div class="left-content">

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
              <label class="section-label">看板列</label>
              <div class="status-group">
                <button
                  v-for="col in projectStore.kanbanColumns"
                  :key="col.key"
                  class="status-btn"
                  :class="['s-' + col.key, { active: localStatus === col.key }]"
                  @click="localStatus = col.key; projectStore.moveProject(project.id, col.key)"
                >
                  <span class="opt-dot"></span>{{ col.label }}
                </button>
              </div>
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

            <hr class="col-divider" />

            <!-- 阶段 -->
            <div class="section stages-section">
              <div class="stages-header">
                <label class="section-label">项目阶段 <span class="label-hint">拖拽排序</span></label>
                <button class="add-stage-btn" @click="addStage">＋ 添加</button>
              </div>
            <div class="stage-flow" ref="stageFlowRef">
              <div
                v-for="(stage, i) in displayStages" :key="stage.key"
                class="stage-node"
                :class="{
                  active: i === activeStageIdx && stage.key !== draggedStageKey,
                  done: i < activeStageIdx && stage.key !== draggedStageKey,
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
                      @blur="saveStages" @keydown.enter="saveStages" @keydown.esc="editingStage = null" @click.stop
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
                <div class="todo-list">
                  <div v-for="todo in (stage.todos ?? [])" :key="todo.id" class="todo-item">
                    <button class="todo-check" :class="{ checked: todo.done }" @click.stop="toggleTodo(todo)">
                      <PhCheck v-if="todo.done" :size="9" weight="bold" />
                    </button>
                    <input
                      :class="['todo-input', `todo-input-${stage.key}`]"
                      v-model="todo.text"
                      :style="todo.done ? { textDecoration: 'line-through', opacity: 0.45 } : {}"
                      placeholder="待办事项"
                      @blur="saveStages"
                      @keydown.enter.prevent="addTodo(stage)"
                      @keydown.backspace="!todo.text && removeTodo(stage, todo.id)"
                    />
                    <button class="todo-del" @click.stop="removeTodo(stage, todo.id)"><PhX :size="8" weight="bold" /></button>
                  </div>
                  <button class="todo-add-btn" @click.stop="addTodo(stage)">＋ 添加待办</button>
                </div>
                <div v-if="i < displayStages.length - 1" class="node-line"></div>
              </div>
            </div>

            <!-- 拖拽虚影（圆圈 + 文字） -->
            <Teleport to="body">
              <div v-if="stageDrag.active" class="stage-drag-ghost-full"
                :style="{ left: stageDrag.ghostX + 'px', top: stageDrag.ghostY + 'px', width: stageDrag.ghostWidth + 'px' }">
                <span class="node-label">{{ stageDrag.ghostLabel }}</span>
              </div>
            </Teleport>
          </div>

            <hr class="col-divider" />

            <!-- 备注 -->
            <div class="section">
              <label class="section-label">备注</label>
              <textarea class="notes-input" v-model="localNotes" placeholder="添加项目描述或备注…" rows="3"></textarea>
            </div>

          </div><!-- /left-content -->
        </div>

        <!-- 右栏：文件 -->
        <div class="modal-right">
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
                @click="navigateTo(-1)"
                @dragover="onPmBcDragOver(-1, null, $event)"
                @dragleave="onPmBcDragLeave(-1)"
                @drop="onPmBcDrop(null, $event)"
              >项目文件</button>
              <template v-for="(seg, idx) in folderStack" :key="seg.id">
                <PhCaretRight :size="10" weight="bold" class="bc-sep" />
                <button v-if="idx < folderStack.length - 1" class="bc-seg"
                  :class="{ 'bc-drop-target': pmBcDragOverIdx === idx }"
                  @click="navigateTo(idx)"
                  @dragover="onPmBcDragOver(idx, seg, $event)"
                  @dragleave="onPmBcDragLeave(idx)"
                  @drop="onPmBcDrop(seg.id, $event)"
                >{{ seg.name }}</button>
                <span v-else class="bc-seg bc-cur">{{ seg.name }}</span>
              </template>
            </nav>
            <!-- 排序选择器 -->
            <div class="sort-selector" @click.stop>
              <button class="sort-btn" @click.stop="pmSortMenuOpen = !pmSortMenuOpen">
                <PhSortAscending :size="13" weight="bold" />
                {{ PM_SORT_OPTIONS.find(o => o.key === pmSortKey)?.label }}
                <svg class="sort-dir-icon" :class="{ desc: pmSortDir === 'desc' }" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                  <path d="M5 2v6M2 5l3-3 3 3"/>
                </svg>
              </button>
              <div v-if="pmSortMenuOpen" class="sort-menu popup-menu">
                <button v-for="opt in PM_SORT_OPTIONS" :key="opt.key"
                  class="sort-menu-item popup-menu-item" :class="{ active: pmSortKey === opt.key }"
                  @click.stop="onPmSortSelect(opt.key)">
                  {{ opt.label }}
                  <svg v-if="pmSortKey === opt.key" class="sort-check" :class="{ desc: pmSortDir === 'desc' }" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                    <path d="M5 2v6M2 5l3-3 3 3"/>
                  </svg>
                </button>
              </div>
            </div>
            <!-- 多选模式 -->
            <button class="sel-mode-btn" :class="{ on: pmInSelectionMode }" @click.stop="togglePmSelectionMode" title="多选模式">
              <PhCheckSquare :size="13" weight="bold" />
            </button>
            <!-- 视图切换 -->
            <div class="view-toggle">
              <button :class="{ on: fileViewMode === 'grid' }" @click="fileViewMode = 'grid'" title="网格视图">
                <PhSquaresFour :size="13" weight="bold" />
              </button>
              <button :class="{ on: fileViewMode === 'list' }" @click="fileViewMode = 'list'" title="列表视图">
                <PhList :size="13" weight="bold" />
              </button>
            </div>
            <!-- 新建文件夹（每层都可用） -->
            <button v-if="!showNewFolder" class="new-folder-btn" @click.stop="showNewFolder = true">
              <PhFolderPlus :size="12" weight="bold" />
              新建文件夹
            </button>
            <div v-else class="new-folder-inline" @click.stop>
              <input class="new-folder-input" v-model="newFolderName" placeholder="文件夹名称"
                @keyup.enter="createFolder" @keyup.esc="showNewFolder = false; newFolderName = ''"
                ref="folderInputRef" autofocus />
              <button class="btn-confirm-sm" :disabled="folderLoading" @click="createFolder">确定</button>
              <button class="btn-cancel-sm" @click="showNewFolder = false; newFolderName = ''">✕</button>
            </div>
            <button class="close-btn" @click="$emit('close')">
              <PhX :size="14" weight="bold" />
            </button>
          </div>

          <div class="file-content" ref="pmGridRef" style="position:relative" @mousedown="onPmGridMouseDown"
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
              <div class="file-grid" @contextmenu.prevent.self="openPmCtx('empty', null, $event)">
                <!-- 文件夹卡片（当前层） -->
                <div v-for="folder in sortedCurrentFolders" :key="folder.id"
                  class="folder-card" :style="{ '--fd-color': accentColor }"
                  :class="{ 'drag-over': pmDragOverFolderId === folder.id, selected: pmSelectedFolderIds.has(folder.id), 'pre-selected': pmPreviewFolderIds.has(folder.id) }"
                  :data-pm-folder-id="folder.id"
                  @click.stop="pmInSelectionMode ? toggleFolderSelectPm(folder) : enterFolder(folder)"
                  @contextmenu.prevent.stop="openPmCtx('folder', folder, $event)"
                  @dragover="onPmFolderDragOver(folder, $event)"
                  @dragleave="onPmFolderDragLeave(folder)"
                  @drop="onPmFolderDrop(folder, $event)">
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
                          @keydown.enter="commitFolderRename" @keydown.esc="cancelFolderRename" @blur="commitFolderRename" @focus="$event.target.select()" />
                      </span>
                      <template v-else>{{ folder.name }}</template>
                    </div>
                    <div class="fd-count">{{ folder.fileCount }} 个文件</div>
                  </div>
                </div>
                <!-- 文件卡片（当前层） -->
                <div v-for="file in sortedCurrentFiles" :key="file.id"
                  class="fc-card" :style="{ '--fc-color': fileIconColor(file.ext) }"
                  :class="{ selected: pmSelectedFileIds.has(file.id), 'pre-selected': pmPreviewFileIds.has(file.id), dragging: pmDraggingFileIds.has(file.id), cut: pmCbStore.type === 'cut' && pmCbStore.fileIds.includes(file.id), 'fc-has-thumb': isPmImageExt(file.ext) }"
                  :data-pm-file-id="file.id"
                  draggable="true"
                  @contextmenu.prevent.stop="openPmCtx('file', file, $event)"
                  @click.stop="pmInSelectionMode ? toggleFileSelectPm(file) : (isPreviewable(file.ext) ? openPreview(file) : onPmFileClick(file, $event))"
                  @dragstart="onPmFileDragStart(file, $event)"
                  @dragend="onPmFileDragEnd">
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
                      @error="$event.target.style.display='none'" />
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
                          @keydown.enter="commitRename" @keydown.esc="cancelRename" @blur="commitRename" @focus="$event.target.select()" />
                      </span>
                      <template v-else>{{ file.displayName }}</template>
                    </div>
                    <div class="fc-meta">{{ file.stageName ? file.stageName + ' · ' : '' }}{{ file.size }}</div>
                  </div>
                </div>
                <!-- 幽灵上传卡片 -->
                <div v-for="g in uploadingItems" :key="g.uid"
                  class="fc-ghost" :class="{ error: g.error }"
                  :style="{ '--fc-color': fileIconColor(g.ext) }">
                  <div class="fc-ghost-fill" :style="{ width: g.progress + '%' }"></div>
                  <span class="fc-ext-badge" :style="{ color: fileIconColor(g.ext), background: fileIconColor(g.ext) + '18' }">{{ g.ext || '—' }}</span>
                  <div class="fc-icon-area">
                    <svg class="fc-big-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
                      <template v-if="fileExtCategory(g.ext) === 'image'">
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
                      <template v-if="g.error">上传失败</template>
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
              </div>
            </template>

            <!-- ── 列表视图 ── -->
            <template v-else>
              <div class="file-list-view" @contextmenu.prevent.self="openPmCtx('empty', null, $event)">
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
                  @click.stop="pmInSelectionMode ? toggleFolderSelectPm(folder) : enterFolder(folder)"
                  @contextmenu.prevent.stop="openPmCtx('folder', folder, $event)"
                  @dragover="onPmFolderDragOver(folder, $event)"
                  @dragleave="onPmFolderDragLeave(folder)"
                  @drop="onPmFolderDrop(folder, $event)">
                  <span class="lr-name-cell">
                    <PhFolder class="lr-folder-icon" :size="16" weight="fill" :style="{ color: accentColor }" />
                    <span class="lr-filename" :title="folder.name">
                      <span v-if="renamingFolderId === folder.id" class="rename-sizer" @click.stop>
                        <span class="rename-ghost">{{ folderRenameText || ' ' }}</span>
                        <input class="rename-input-inline" v-model="folderRenameText"
                          @keydown.enter="commitFolderRename" @keydown.esc="cancelFolderRename" @blur="commitFolderRename" @focus="$event.target.select()" />
                      </span>
                      <template v-else>{{ folder.name }}</template>
                    </span>
                  </span>
                  <span class="lr-text">—</span>
                  <span class="lr-text">{{ folder.fileCount }} 项</span>
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
                  draggable="true"
                  @contextmenu.prevent.stop="openPmCtx('file', file, $event)"
                  @click.stop="pmInSelectionMode ? toggleFileSelectPm(file) : (isPreviewable(file.ext) ? openPreview(file) : onPmFileClick(file, $event))"
                  @dragstart="onPmFileDragStart(file, $event)"
                  @dragend="onPmFileDragEnd">
                  <span class="lr-name-cell">
                    <span class="lr-ext" :style="{ color: fileIconColor(file.ext), background: fileIconColor(file.ext) + '18' }">{{ file.ext }}</span>
                    <span class="lr-filename" :title="file.displayName">
                      <span v-if="renamingFileId === file.id" class="rename-sizer" @click.stop>
                        <span class="rename-ghost">{{ renameText || ' ' }}</span>
                        <input class="rename-input-inline" v-model="renameText"
                          @keydown.enter="commitRename" @keydown.esc="cancelRename" @blur="commitRename" @focus="$event.target.select()" />
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
                <!-- 幽灵上传行 -->
                <div v-for="g in uploadingItems" :key="g.uid"
                  class="list-row fc-ghost-row" :class="{ error: g.error }">
                  <div class="fc-ghost-fill" :style="{ width: g.progress + '%' }"></div>
                  <span class="lr-name-cell">
                    <span class="lr-ext" :style="{ color: fileIconColor(g.ext), background: fileIconColor(g.ext) + '18' }">{{ g.ext || '—' }}</span>
                    <span class="lr-filename">{{ g.name }}</span>
                  </span>
                  <span class="lr-text">—</span>
                  <span class="lr-text">—</span>
                  <span class="lr-text">
                    <template v-if="g.error">失败</template>
                    <template v-else>{{ g.progress }}%</template>
                  </span>
                  <span class="lr-actions"></span>
                </div>
                <!-- 上传行 -->
                <label class="list-upload-row" @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="handleFileDrop">
                  <PhUploadSimple :size="13" weight="bold" />
                  上传文件 <input type="file" hidden multiple @change="handleFileInput" />
                </label>
              </div>
            </template>

            <!-- 批量操作浮动栏 -->
            <Transition name="pm-action-bar">
              <div v-if="pmInSelectionMode" class="pm-selection-bar" @click.stop>
                <span class="pm-sel-count">已选 {{ pmSelectedFileIds.size + pmSelectedFolderIds.size }} 项</span>
                <button class="pm-sel-download-btn" @click="downloadSelectedPm" :disabled="(pmSelectedFileIds.size === 0 && pmSelectedFolderIds.size === 0) || pmDownloadingZip">
                  <PhDownloadSimple v-if="!pmDownloadingZip" :size="11" weight="bold" />
                  <svg v-else class="spin" width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                    <path d="M7 1a6 6 0 1 1-4.24 1.76"/>
                  </svg>
                  {{ pmDownloadingZip ? '下载中…' : '下载' }}
                </button>
                <div class="sel-divider"></div>
                <button class="pm-sel-action-btn" @click="pmSelCut" title="剪切">
                  <PhScissors :size="11" weight="bold" />
                  剪切
                </button>
                <button class="pm-sel-action-btn" @click="pmSelCopy" title="复制">
                  <PhCopy :size="11" weight="bold" />
                  复制
                </button>
                <div class="sel-divider"></div>
                <button class="pm-sel-delete-btn" @click="deleteSelectedPm">
                  <PhTrash :size="11" weight="bold" />
                  删除
                </button>
                <button class="pm-sel-cancel-btn" @click="clearPmSelection">取消</button>
              </div>
            </Transition>
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
    :file="pmInfoPopup.file"
    :x="pmInfoPopup.x"
    :y="pmInfoPopup.y"
    @close="pmInfoPopup.show = false"
  />
</template>

<script setup>
import { ref, reactive, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useProjectStore } from '@/stores/projects'
import { useFilesCacheStore } from '@/stores/filesCache'
import { filesApi, foldersApi, uploadWithProgress } from '@/services/api'
import { getThumb, getCachedThumb, thumbLoadedIds, preloadTinyThumbs } from '@/composables/useThumbCache'
import DatePicker from '@/components/common/DatePicker.vue'
import DateSpanPicker from '@/components/common/DateSpanPicker.vue'
import BaseModal from '@/components/common/BaseModal.vue'
import { usePreviewStore, isPreviewable } from '@/stores/preview'
import {
  PhFolder, PhArrowLeft, PhArrowRight, PhCaretRight, PhCaretDown, PhSortAscending, PhSquaresFour, PhList,
  PhCheckSquare, PhFolderPlus, PhUploadSimple, PhPencilSimple,
  PhDownloadSimple, PhScissors, PhCopy, PhClipboardText, PhX, PhCheck,
  PhInfo, PhWarningCircle, PhDotsThree, PhTrash,
} from '@phosphor-icons/vue'
import ContextMenu   from '@/components/ContextMenu.vue'
import FileInfoPopup from '@/components/common/FileInfoPopup.vue'
import { useClipboardStore } from '@/stores/clipboard'

const props = defineProps({ project: { type: Object, default: null } })
const emit = defineEmits(['close'])
function onModalClose() { emit('close'); pmSortMenuOpen.value = false }

const projectStore     = useProjectStore()
const fileCacheStore   = useFilesCacheStore()
const editingStage     = ref(null)
const stageInputRef    = ref(null)
const stageFlowRef     = ref(null)
const stageDrag = reactive({
  active: false, fromIdx: -1, overIdx: -1,
  ghostX: 0, ghostY: 0, ghostLabel: '',
  ghostNum: 1, ghostIsActive: false, ghostIsDone: false,
  ghostWidth: 200, grabOffsetX: 0, grabOffsetY: 0,
})
const dragging         = ref(false)
const pmDragCounter    = ref(0)
const pmIsDragging     = computed(() => pmDragCounter.value > 0)
const startPickerRef    = ref(null)
const deadlinePickerRef = ref(null)
const editingName      = ref(false)
const localName        = ref('')
const nameInputRef     = ref(null)

const localStages      = ref([])
const expandedStages   = ref(new Set())
const localStartDate = ref('')
const localDeadline  = ref('')
const localClient    = ref('')
const localNotes     = ref('')
const localColor        = ref('')
const localCurrentStage = ref('')
const localStatus       = ref('')
const fileViewMode   = ref('grid')
const projectFiles   = ref([])
const projectFolders = ref([])
const folderFilesMap = ref({})   // { [folderId]: File[] }
const openFolders    = ref(new Set())
const folderStack    = ref([])   // 导航路径栈，根目录 = 空数组
const pmNavStack     = ref([[]])  // history: array of folderStack snapshots
const pmNavCursor    = ref(0)
let _isPmHistoryNav  = false

const pmCanGoBack    = computed(() => pmNavCursor.value > 0)
const pmCanGoForward = computed(() => pmNavCursor.value < pmNavStack.value.length - 1)

function _pushPmHistory() {
  if (_isPmHistoryNav) return
  pmNavStack.value = pmNavStack.value.slice(0, pmNavCursor.value + 1)
  pmNavStack.value.push([...folderStack.value])
  pmNavCursor.value = pmNavStack.value.length - 1
}

function pmGoBack() {
  if (!pmCanGoBack.value) return
  _isPmHistoryNav = true
  pmNavCursor.value--
  folderStack.value = [...pmNavStack.value[pmNavCursor.value]]
  nextTick(() => { _isPmHistoryNav = false })
}

function pmGoForward() {
  if (!pmCanGoForward.value) return
  _isPmHistoryNav = true
  pmNavCursor.value++
  folderStack.value = [...pmNavStack.value[pmNavCursor.value]]
  nextTick(() => { _isPmHistoryNav = false })
}
const subFolderMap   = ref({})   // { [parentId]: Folder[] }

// 当前层的文件夹（根目录用 projectFolders，子目录用 subFolderMap）
const currentFolders = computed(() => {
  if (!folderStack.value.length) return projectFolders.value
  const parentId = folderStack.value[folderStack.value.length - 1].id
  return subFolderMap.value[parentId] ?? []
})

// 当前层的文件（根目录用 projectFiles，子目录用 folderFilesMap）
const currentFiles = computed(() => {
  if (!folderStack.value.length) return projectFiles.value
  const folderId = folderStack.value[folderStack.value.length - 1].id
  return folderFilesMap.value[folderId] ?? []
})
watch(currentFiles, files => { if (files?.length) preloadTinyThumbs(files) })

// 兼容旧模板引用（进入文件夹后的文件）
const currentFolder = computed(() =>
  folderStack.value.length ? folderStack.value[folderStack.value.length - 1] : null
)
const currentFolderFiles = computed(() => currentFiles.value)

const totalFileCount = computed(() =>
  projectFiles.value.length + projectFolders.value.reduce((s, f) => s + (f.fileCount ?? 0), 0)
)

// ── 框选 ──────────────────────────────────────────────────────────────────────
const pmGridRef           = ref(null)
const pmSelectedFileIds   = ref(new Set())
const pmSelectedFolderIds = ref(new Set())
const pmPreviewFileIds    = ref(new Set())
const pmPreviewFolderIds  = ref(new Set())
const pmBoxStart          = ref(null)
const pmBoxEnd            = ref(null)
let _pmCRect              = null
let _pmLatestPreview      = { fileIds: new Set(), folderIds: new Set() }

const pmSelectionRect = computed(() => {
  if (!pmBoxStart.value || !pmBoxEnd.value) return null
  const x1 = Math.min(pmBoxStart.value.x, pmBoxEnd.value.x)
  const x2 = Math.max(pmBoxStart.value.x, pmBoxEnd.value.x)
  const y1 = Math.min(pmBoxStart.value.y, pmBoxEnd.value.y)
  const y2 = Math.max(pmBoxStart.value.y, pmBoxEnd.value.y)
  if (x2 - x1 < 3 && y2 - y1 < 3) return null
  return { left: x1, top: y1, width: x2 - x1, height: y2 - y1 }
})

const pmSelectionModeForced = ref(false)
const pmDownloadingZip      = ref(false)
const pmInSelectionMode = computed(() =>
  pmSelectionModeForced.value || pmSelectedFileIds.value.size > 0 || pmSelectedFolderIds.value.size > 0
)

function _pmSwallowClick(e) { e.stopImmediatePropagation() }
function clearPmSelection() {
  pmSelectedFileIds.value = new Set()
  pmSelectedFolderIds.value = new Set()
  pmSelectionModeForced.value = false
}
function togglePmSelectionMode() {
  if (pmInSelectionMode.value) clearPmSelection()
  else pmSelectionModeForced.value = true
}
function toggleFolderSelectPm(folder) {
  const ids = new Set(pmSelectedFolderIds.value)
  if (ids.has(folder.id)) ids.delete(folder.id); else ids.add(folder.id)
  pmSelectedFolderIds.value = ids
}
function toggleFileSelectPm(file) {
  const ids = new Set(pmSelectedFileIds.value)
  if (ids.has(file.id)) ids.delete(file.id); else ids.add(file.id)
  pmSelectedFileIds.value = ids
}

function onPmGridMouseDown(e) {
  if (e.button !== 0) return
  if (e.target.closest('button, input, .folder-card, .fc-card, .fc-upload, label')) return
  if (!pmGridRef.value) return
  _pmCRect = pmGridRef.value.getBoundingClientRect()
  const st = pmGridRef.value.scrollTop
  pmBoxStart.value = { x: e.clientX - _pmCRect.left, y: e.clientY - _pmCRect.top + st }
  pmBoxEnd.value   = { ...pmBoxStart.value }
  document.addEventListener('mousemove', _onPmGridMouseMove)
  document.addEventListener('mouseup',   _onPmGridMouseUp)
}
function _onPmGridMouseMove(e) {
  if (!_pmCRect || !pmGridRef.value) return
  const st = pmGridRef.value.scrollTop
  pmBoxEnd.value = { x: e.clientX - _pmCRect.left, y: e.clientY - _pmCRect.top + st }
  _updatePmPreview()
}
function _onPmGridMouseUp(e) {
  document.removeEventListener('mousemove', _onPmGridMouseMove)
  document.removeEventListener('mouseup',   _onPmGridMouseUp)
  if (pmSelectionRect.value) {
    pmSelectedFileIds.value   = _pmLatestPreview.fileIds
    pmSelectedFolderIds.value = _pmLatestPreview.folderIds
    if (_pmLatestPreview.fileIds.size + _pmLatestPreview.folderIds.size > 0)
      pmSelectionModeForced.value = true
    document.addEventListener('click', _pmSwallowClick, { capture: true, once: true })
  } else if (!e.ctrlKey && !e.metaKey) {
    clearPmSelection()
  }
  _pmLatestPreview      = { fileIds: new Set(), folderIds: new Set() }
  pmPreviewFileIds.value   = new Set()
  pmPreviewFolderIds.value = new Set()
  pmBoxStart.value    = null
  pmBoxEnd.value      = null
  _pmCRect            = null
}
function _getPmItemsInBox() {
  const rect = pmSelectionRect.value
  if (!rect || !pmGridRef.value) return { fileIds: new Set(), folderIds: new Set() }
  const cRect     = pmGridRef.value.getBoundingClientRect()
  const st        = pmGridRef.value.scrollTop
  const fileIds   = new Set()
  const folderIds = new Set()
  pmGridRef.value.querySelectorAll('[data-pm-file-id], [data-pm-folder-id]').forEach(el => {
    const er = el.getBoundingClientRect()
    const l = er.left - cRect.left, t = er.top - cRect.top + st
    if (l < rect.left + rect.width && l + er.width > rect.left &&
        t < rect.top  + rect.height && t + er.height > rect.top) {
      if (el.dataset.pmFileId)   fileIds.add(Number(el.dataset.pmFileId))
      if (el.dataset.pmFolderId) folderIds.add(Number(el.dataset.pmFolderId))
    }
  })
  return { fileIds, folderIds }
}
function _updatePmPreview() {
  if (!pmSelectionRect.value) {
    _pmLatestPreview = { fileIds: new Set(), folderIds: new Set() }
    pmPreviewFileIds.value = new Set(); pmPreviewFolderIds.value = new Set(); return
  }
  const { fileIds, folderIds } = _getPmItemsInBox()
  _pmLatestPreview = { fileIds, folderIds }
  pmPreviewFileIds.value = fileIds; pmPreviewFolderIds.value = folderIds
}
function onPmFileClick(file, e) {
  const ids = new Set(pmSelectedFileIds.value)
  if (e.ctrlKey || e.metaKey) {
    if (ids.has(file.id)) ids.delete(file.id); else ids.add(file.id)
  } else {
    if (ids.size === 1 && ids.has(file.id)) ids.clear()
    else { ids.clear(); ids.add(file.id) }
  }
  pmSelectedFileIds.value = ids
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
    console.error('[ProjectModal] 批量下载失败:', e.message)
  } finally {
    pmDownloadingZip.value = false
  }
}

async function deleteSelectedPm() {
  const fids = [...pmSelectedFileIds.value]
  const dids = [...pmSelectedFolderIds.value]
  if (!fids.length && !dids.length) return
  clearPmSelection()
  try {
    await Promise.all([
      ...fids.map(id => filesApi.delete(id)),
      ...dids.map(id => foldersApi.delete(id)),
    ])
    const pid = props.project?.id; if (!pid) return
    const [files, folders] = await Promise.all([
      filesApi.list({ projectId: pid }),
      foldersApi.list({ projectId: pid }),
    ])
    projectFiles.value   = files.filter(f => !f.folderId)
    projectFolders.value = folders
    folderFilesMap.value = {}; subFolderMap.value = {}; folderStack.value = []
    pmNavStack.value = [[]]; pmNavCursor.value = 0
  } catch (err) { console.error('[ProjectModal] 批量删除失败:', err.message) }
}

// ── 拖动移动 ──────────────────────────────────────────────────────────────────
const pmDraggingFileIds  = ref(new Set())
const pmDragOverFolderId = ref(null)
const pmBcDragOverIdx    = ref(null)

function onPmFileDragStart(file, e) {
  const ids = pmSelectedFileIds.value.has(file.id) && pmSelectedFileIds.value.size > 0
    ? [...pmSelectedFileIds.value] : [file.id]
  pmDraggingFileIds.value = new Set(ids)
  e.dataTransfer.setData('text/plain', JSON.stringify(ids))
  e.dataTransfer.effectAllowed = 'move'
  document.removeEventListener('mousemove', _onPmGridMouseMove)
  document.removeEventListener('mouseup',   _onPmGridMouseUp)
  pmBoxStart.value = null
  pmBoxEnd.value = null
  pmPreviewFileIds.value = new Set()
  pmPreviewFolderIds.value = new Set()
}
function onPmFileDragEnd() {
  pmDraggingFileIds.value = new Set()
  pmDragOverFolderId.value = null
}
function onPmBcDragOver(idx, _seg, e) {
  if (!pmDraggingFileIds.value.size) return
  e.preventDefault(); e.dataTransfer.dropEffect = 'move'
  pmBcDragOverIdx.value = idx
}
function onPmBcDragLeave(idx) {
  if (pmBcDragOverIdx.value === idx) pmBcDragOverIdx.value = null
}
async function onPmBcDrop(targetFolderId, e) {
  e.preventDefault(); pmBcDragOverIdx.value = null
  let ids; try { ids = JSON.parse(e.dataTransfer.getData('text/plain')) } catch { return }
  if (!ids?.length) return
  const pid = props.project?.id; if (!pid) return
  try {
    await Promise.all(ids.map(id => filesApi.update(id, { folder_id: targetFolderId })))
    pmDraggingFileIds.value = new Set(); clearPmSelection()
    // 刷新当前层文件列表（文件已移走）
    const stack = folderStack.value
    if (!stack.length) {
      const files = await filesApi.list({ projectId: pid })
      projectFiles.value = files.filter(f => !f.folderId)
    } else {
      const fid = stack[stack.length - 1].id
      const files = await filesApi.list({ folderId: fid })
      folderFilesMap.value = { ...folderFilesMap.value, [fid]: files }
    }
  } catch (err) { console.error('[ProjectModal] 移动失败:', err.message) }
}

function onPmFolderDragOver(folder, e) {
  e.preventDefault(); e.dataTransfer.dropEffect = 'move'
  pmDragOverFolderId.value = folder.id
}
function onPmFolderDragLeave(folder) {
  if (pmDragOverFolderId.value === folder.id) pmDragOverFolderId.value = null
}
async function onPmFolderDrop(folder, e) {
  e.preventDefault(); pmDragOverFolderId.value = null
  let ids; try { ids = JSON.parse(e.dataTransfer.getData('text/plain')) } catch { return }
  if (!ids?.length) return
  try {
    await Promise.all(ids.map(id => filesApi.update(id, { folder_id: folder.id })))
    pmDraggingFileIds.value = new Set(); clearPmSelection()
    const pid = props.project?.id; if (!pid) return
    const [files, folders] = await Promise.all([
      filesApi.list({ projectId: pid }),
      foldersApi.list({ projectId: pid }),
    ])
    projectFiles.value   = files.filter(f => !f.folderId)
    projectFolders.value = folders
    folderFilesMap.value = {}; subFolderMap.value = {}; folderStack.value = []
    pmNavStack.value = [[]]; pmNavCursor.value = 0
  } catch (err) { console.error('[ProjectModal] 移动失败:', err.message) }
}

// ── 排序 ──────────────────────────────────────────────────────────────────────

const PM_SORT_OPTIONS = [
  { key: 'name',      label: '名称' },
  { key: 'type',      label: '类型' },
  { key: 'stage',     label: '阶段' },
  { key: 'createdAt', label: '创建时间' },
  { key: 'size',      label: '大小' },
]
const pmSortKey      = ref('name')
const pmSortDir      = ref('asc')
const pmSortMenuOpen = ref(false)

function onPmSortSelect(key) {
  if (pmSortKey.value === key) {
    pmSortDir.value = pmSortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    pmSortKey.value = key
    pmSortDir.value = 'asc'
  }
  pmSortMenuOpen.value = false
}

const sortedCurrentFolders = computed(() => {
  const dir = pmSortDir.value === 'asc' ? 1 : -1
  return [...currentFolders.value].sort((a, b) => {
    if (pmSortKey.value === 'name' || pmSortKey.value === 'type') {
      return dir * (a.name ?? '').localeCompare(b.name ?? '', 'zh')
    }
    return dir * ((a.id > b.id ? 1 : a.id < b.id ? -1 : 0))
  })
})

const sortedCurrentFiles = computed(() => {
  const dir = pmSortDir.value === 'asc' ? 1 : -1
  return [...currentFiles.value].sort((a, b) => {
    if (pmSortKey.value === 'name') {
      return dir * (a.displayName ?? '').localeCompare(b.displayName ?? '', 'zh')
    }
    if (pmSortKey.value === 'type') {
      const ca = fileExtCategory(a.ext), cb = fileExtCategory(b.ext)
      if (ca !== cb) return dir * ca.localeCompare(cb)
      return dir * (a.ext ?? '').localeCompare(b.ext ?? '')
    }
    if (pmSortKey.value === 'stage') {
      return dir * (a.stageName ?? '').localeCompare(b.stageName ?? '', 'zh')
    }
    if (pmSortKey.value === 'createdAt') {
      return dir * (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
    }
    if (pmSortKey.value === 'size') {
      return dir * ((a.sizeBytes ?? 0) - (b.sizeBytes ?? 0))
    }
    return 0
  })
})

// ── 文件夹 ────────────────────────────────────────────────────────────────────

const showNewFolder  = ref(false)
const newFolderName  = ref('')
const folderLoading  = ref(false)
const folderInputRef = ref(null)

watch(showNewFolder, v => { if (v) nextTick(() => folderInputRef.value?.focus()) })

async function loadFolders(projectId, parentId = null) {
  try {
    const folders = await foldersApi.list({ projectId, parentId })
    if (parentId == null) {
      projectFolders.value = folders
    } else {
      subFolderMap.value = { ...subFolderMap.value, [parentId]: folders }
    }
  } catch {
    if (parentId == null) projectFolders.value = []
    else subFolderMap.value = { ...subFolderMap.value, [parentId]: [] }
  }
}

async function createFolder() {
  const name = newFolderName.value.trim()
  if (!name || !props.project?.id) return
  const stack = folderStack.value
  const parentId = stack.length ? stack[stack.length - 1].id : null
  folderLoading.value = true
  try {
    const created = await foldersApi.create(props.project.id, name, parentId)
    newFolderName.value = ''
    showNewFolder.value = false
    // 刷新当前层级的文件夹列表
    if (parentId == null) {
      await loadFolders(props.project.id)
    } else {
      subFolderMap.value = {
        ...subFolderMap.value,
        [parentId]: [created, ...(subFolderMap.value[parentId] ?? [])],
      }
    }
  } catch (e) {
    console.error('[ProjectModal] 新建文件夹失败:', e.message)
  } finally {
    folderLoading.value = false
  }
}

async function enterFolder(folder) {
  folderStack.value = [...folderStack.value, folder]
  _pushPmHistory()
  // 加载该层的文件和子文件夹（如未缓存）
  const promises = []
  if (!folderFilesMap.value[folder.id]) {
    promises.push(
      filesApi.list({ folderId: folder.id })
        .then(files => { folderFilesMap.value = { ...folderFilesMap.value, [folder.id]: files } })
        .catch(() => { folderFilesMap.value = { ...folderFilesMap.value, [folder.id]: [] } })
    )
  }
  if (!subFolderMap.value[folder.id]) {
    promises.push(loadFolders(props.project?.id ?? null, folder.id))
  }
  await Promise.all(promises)
}

function navigateTo(idx) {
  folderStack.value = idx < 0 ? [] : folderStack.value.slice(0, idx + 1)
  _pushPmHistory()
}

// ── 重命名 ────────────────────────────────────────────────────────────────────

const renamingFileId = ref(null)
const renameText     = ref('')

function startRename(file) {
  renamingFileId.value = file.id
  renameText.value     = file.displayName
  nextTick(() => {
    const el = document.querySelector('.rename-input-inline')
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
    // 更新本地数据
    const inRoot = projectFiles.value.find(f => f.id === id)
    if (inRoot) inRoot.displayName = name
    for (const fid of Object.keys(folderFilesMap.value)) {
      const f = folderFilesMap.value[fid]?.find(f => f.id === id)
      if (f) f.displayName = name
    }
  } catch (e) {
    console.error('[ProjectModal] 重命名失败:', e.message)
  }
}

// ── 删除 ─────────────────────────────────────────────────────────────────────

async function deleteFile(file) {
  try {
    await filesApi.delete(file.id)
    projectFiles.value = projectFiles.value.filter(f => f.id !== file.id)
    for (const fid of Object.keys(folderFilesMap.value)) {
      folderFilesMap.value = {
        ...folderFilesMap.value,
        [fid]: (folderFilesMap.value[fid] ?? []).filter(f => f.id !== file.id),
      }
    }
    // 更新文件夹计数
    await loadFolders(props.project.id)
  } catch (e) {
    console.error('[ProjectModal] 删除失败:', e.message)
  }
}

// ── 下载 ─────────────────────────────────────────────────────────────────────

function downloadFile(file) {
  filesApi.download(file.id, file.displayName + '.' + file.ext.toLowerCase())
}

// ── 预览 ──
const previewStore = usePreviewStore()
const openPreview = (f) => previewStore.open(f)

// ── 文件类型辅助 ──────────────────────────────────────────────────────────────

function fileExtCategory(ext) {
  const e = (ext || '').toLowerCase()
  if (['jpg','jpeg','png','gif','webp','svg','ico','bmp','avif','heic','tif','tiff'].includes(e)) return 'image'
  if (['mp4','mov','avi','mkv','webm','wmv','flv','m4v'].includes(e)) return 'video'
  if (['mp3','wav','flac','aac','ogg','m4a','wma','opus'].includes(e)) return 'audio'
  if (['xls','xlsx','csv','ods','numbers'].includes(e)) return 'sheet'
  if (['ppt','pptx','key','odp'].includes(e)) return 'slide'
  if (['zip','rar','7z','tar','gz','bz2','xz'].includes(e)) return 'archive'
  if (['js','ts','jsx','tsx','vue','py','go','rs','java','cpp','c','cs','rb','swift','php','kt','dart','sh',
       'html','css','scss','less','xml','json','yaml','yml','toml','md','mdx','graphql'].includes(e)) return 'code'
  return 'doc'
}

function fileIconColor(ext) {
  const cat = fileExtCategory(ext)
  const map = { image: '#b07858', video: '#8868a0', audio: '#a07088', sheet: '#508870',
                slide: '#a07840', archive: '#808888', code: '#688858' }
  return map[cat] ?? '#8888a8'
}

const _PM_IMG_EXTS   = new Set(['jpg','jpeg','png','gif','webp','avif','bmp','heic','heif'])
const isPmImageExt   = (ext) => _PM_IMG_EXTS.has((ext || '').toLowerCase())

const vLazySrc = {
  mounted(el, { value: { id, size } }) {
    if (!id) return
    const cached = getCachedThumb(id, size)
    if (cached) { el.src = cached; return }
    if (size === 'tiny') {
      getThumb(id, size).then(url => { if (url) el.src = url })
      return
    }
    const obs = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return
      obs.disconnect(); el._lazySrcObs = null
      getThumb(id, size).then(url => { if (url) el.src = url })
    }, { rootMargin: '200px' })
    obs.observe(el); el._lazySrcObs = obs
  },
  updated(el, { value: { id, size }, oldValue }) {
    if (id === oldValue?.id && size === oldValue?.size) return
    el._lazySrcObs?.disconnect()
    const cached = getCachedThumb(id, size)
    if (cached) { el.src = cached; return }
    if (size === 'tiny') {
      getThumb(id, size).then(url => { if (url) el.src = url })
      return
    }
    const obs = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return
      obs.disconnect(); el._lazySrcObs = null
      getThumb(id, size).then(url => { if (url) el.src = url })
    }, { rootMargin: '200px' })
    obs.observe(el); el._lazySrcObs = obs
  },
  unmounted(el) { el._lazySrcObs?.disconnect(); el._lazySrcObs = null },
}

// ── 文件夹操作 ────────────────────────────────────────────────────────────────

const renamingFolderId  = ref(null)
const folderRenameText  = ref('')

function startRenameFolder(folder) {
  renamingFolderId.value = folder.id
  folderRenameText.value = folder.name
  nextTick(() => {
    const el = document.querySelector('.rename-input-inline')
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
    await foldersApi.rename(id, name)
    await loadFolders(props.project.id)
  } catch (e) {
    console.error('[ProjectModal] 文件夹重命名失败:', e.message)
  }
}

function downloadFolderZip(folder) {
  foldersApi.download(folder.id, folder.name)
}

function prunePmHistoryForFolder(folderId) {
  const hasDeleted = snap => snap.some(f => f.id === folderId)
  const curIdx = pmNavCursor.value
  let newCursor = 0
  const kept = []
  pmNavStack.value.forEach((snap, i) => {
    if (!hasDeleted(snap)) {
      if (i <= curIdx) newCursor = kept.length
      kept.push(snap)
    }
  })
  if (!kept.length) kept.push([])
  pmNavStack.value = kept
  pmNavCursor.value = Math.min(newCursor, kept.length - 1)
}

async function deleteFolderCard(folder) {
  if (!confirm(`删除文件夹「${folder.name}」？其中的文件将移至项目根目录。`)) return
  prunePmHistoryForFolder(folder.id)
  try {
    await foldersApi.delete(folder.id)
    await loadFolders(props.project.id)
  } catch (e) {
    console.error('[ProjectModal] 删除文件夹失败:', e.message)
  }
}

let initializing = false


watch(() => props.project?.id, async (id) => {
  initializing = true
  localStages.value       = props.project ? props.project.stages.map(s => ({ ...s })) : []
  localName.value         = props.project?.name         ?? ''
  localStartDate.value    = props.project?.startDate    ?? ''
  localDeadline.value     = props.project?.deadline     ?? ''
  localClient.value       = props.project?.client       ?? ''
  localNotes.value        = props.project?.notes        ?? ''
  localColor.value        = props.project?.color        ?? ''
  localCurrentStage.value = props.project?.currentStage ?? ''
  localStatus.value       = props.project?.status       ?? ''
  recalcStageState()
  editingStage.value   = null
  projectFiles.value   = []
  projectFolders.value = []
  folderFilesMap.value = {}
  subFolderMap.value   = {}
  openFolders.value    = new Set()
  folderStack.value    = []
  showNewFolder.value  = false
  await nextTick()
  initializing = false
  if (!id) return
  // 热缓存：从 filesCacheStore 立即预填，避免等待 API 时文件区域为空
  if (fileCacheStore.loaded) {
    projectFiles.value   = fileCacheStore.getProjectRootFiles(id)
    projectFolders.value = fileCacheStore.getProjectRootFolders(id)
  }
  try {
    const [files, folders] = await Promise.all([
      filesApi.list({ projectId: id }),
      foldersApi.list({ projectId: id }),
    ])
    projectFiles.value   = files.filter(f => !f.folderId)
    projectFolders.value = folders
  } catch {
    // 后端未启动时保持空列表
  }
}, { immediate: true })

watch(localClient, v => {
  if (initializing) return
  const id = props.project?.id
  if (!id) return
  const p = projectStore.projects.find(p => p.id === id)
  if (p) p.client = v || null
  projectStore.updateProject(id, { client: v || null })
})

watch(localStartDate, v => {
  if (initializing) return
  const id = props.project?.id
  if (!id) return
  const p = projectStore.projects.find(p => p.id === id)
  if (p) p.startDate = v
  projectStore.updateProject(id, { startDate: v || null })
})

function onStartDatePicked(v) {
  startPickerRef.value?.closePicker()
  if (v) setTimeout(() => deadlinePickerRef.value?.openPicker(), 80)
}
watch(localDeadline, v => {
  if (initializing) return
  const id = props.project?.id
  if (!id) return
  const p = projectStore.projects.find(p => p.id === id)
  if (p) p.deadline = v
  projectStore.updateProject(id, { deadline: v || null })
})

let _notesTimer = null
watch(localNotes, v => {
  if (initializing) return
  const id = props.project?.id
  if (!id) return
  clearTimeout(_notesTimer)
  _notesTimer = setTimeout(() => {
    projectStore.updateProject(id, { notes: v })
  }, 600)
})

const currentStageIndex = computed(() =>
  localStages.value.findIndex(s => s.key === localCurrentStage.value)
)
// 当前阶段所在位置索引（位置固定，拖动重排不改变）
const activeStageIdx = ref(-1)

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
const stageProgress = ref(0)

function calcProgress(stages, currentStageKey) {
  if (!stages.length) return 0
  const idx = stages.findIndex(s => s.key === currentStageKey)
  if (idx < 0) return 0
  const w = 100 / stages.length
  const todos = stages[idx].todos ?? []
  const within = todos.length > 0 ? (todos.filter(t => t.done).length / todos.length) * w : w
  return Math.round(idx * w + within)
}

// 只在明确切换阶段时调用，拖动重排不触发
function recalcStageState() {
  const stages = localStages.value
  const idx = stages.findIndex(s => s.key === localCurrentStage.value)
  activeStageIdx.value = idx
  stageProgress.value = calcProgress(stages, localCurrentStage.value)
}

function extractAccent(colorStr) {
  const m = colorStr?.match(/#[0-9a-fA-F]{6}/)
  return m ? m[0] : '#7b7fb2'
}
const accentColor   = computed(() => extractAccent(localColor.value || props.project?.color))
const accentColorBg = computed(() => {
  const c = accentColor.value
  return c ? c.replace(/^#/, '') .match(/.{2}/g)
    ?.map(x => parseInt(x, 16))
    .reduce((_, __, ___, a) => `rgba(${a[0]},${a[1]},${a[2]},0.12)`, 'rgba(123,127,178,0.12)')
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
  editingName.value = false
}

function setColor(c) {
  localColor.value = c
  projectStore.updateProject(props.project.id, { color: c })
}

function setStage(key, idx) {
  localCurrentStage.value = key
  activeStageIdx.value = idx
  const newProgress = calcProgress(localStages.value, key)
  stageProgress.value = newProgress
  projectStore.setStage(props.project.id, key, newProgress)
}

async function handleDelete() {
  if (!props.project) return
  await projectStore.deleteProject(props.project.id)
  emit('close')
}

function startEdit(key) {
  editingStage.value = key
  nextTick(() => stageInputRef.value?.[0]?.focus())
}
function saveStages() {
  editingStage.value = null
  projectStore.updateStages(props.project.id, localStages.value)
}
function addStage() {
  const key = `stage_${Date.now()}`
  localStages.value.push({ key, label: '新阶段' })
  saveStages()
  nextTick(() => startEdit(key))
}
function removeStage(key) {
  if (localStages.value.length <= 1) return
  localStages.value = localStages.value.filter(s => s.key !== key)
  expandedStages.value.delete(key)
  saveStages()
}

function toggleExpand(key) {
  const s = expandedStages.value
  s.has(key) ? s.delete(key) : s.add(key)
  expandedStages.value = new Set(s)
}
function saveTodos() {
  if (!props.project) return
  const newProgress = calcProgress(localStages.value, localCurrentStage.value)
  stageProgress.value = newProgress
  const p = projectStore.projects.find(p => p.id === props.project.id)
  if (p) { p.stages = localStages.value; p.progress = newProgress }
  projectsApi.update(props.project.id, { stages: localStages.value, progress: newProgress })
}
function addTodo(stage) {
  if (!stage.todos) stage.todos = []
  stage.todos.push({ id: `td_${Date.now()}`, text: '', done: false })
  saveTodos()
  nextTick(() => {
    const inputs = document.querySelectorAll(`.todo-input-${stage.key}`)
    inputs[inputs.length - 1]?.focus()
  })
}
function removeTodo(stage, id) {
  stage.todos = (stage.todos ?? []).filter(t => t.id !== id)
  saveTodos()
}
function toggleTodo(todo) {
  todo.done = !todo.done
  saveTodos()
}

function stageIdxFromY(y) {
  if (!stageFlowRef.value) return -1
  const nodes = stageFlowRef.value.querySelectorAll('.stage-node')
  let best = -1, bestDist = Infinity
  nodes.forEach((el, i) => {
    const rect = el.getBoundingClientRect()
    const center = (rect.top + rect.bottom) / 2
    const d = Math.abs(y - center)
    if (d < bestDist) { bestDist = d; best = i }
  })
  return best
}

function startStageDrag(fromIdx, e) {
  const startX = e.clientX, startY = e.clientY
  const el = e.currentTarget
  const rect = el.getBoundingClientRect()
  const grabOffsetX = e.clientX - rect.left
  const grabOffsetY = e.clientY - rect.top
  let activated = false

  const mm = (ev) => {
    if (!activated) {
      const dx = ev.clientX - startX, dy = ev.clientY - startY
      if (Math.sqrt(dx * dx + dy * dy) < 4) return
      activated = true
      const stage = localStages.value[fromIdx]
      stageDrag.active       = true
      stageDrag.fromIdx      = fromIdx
      stageDrag.overIdx      = fromIdx
      stageDrag.ghostLabel   = stage?.label ?? ''
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
      stageDrag.active = false
      stageDrag.fromIdx = -1
      stageDrag.overIdx = -1
      commitStageDrag()
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
  const stages = [...localStages.value]
  const [moved] = stages.splice(fromIdx, 1)
  const to = Math.max(0, Math.min(overIdx, stages.length))
  stages.splice(to, 0, moved)
  localStages.value = stages
  saveStages()
}

const uploadingItems = ref([])
let _uploadUid = 0

async function uploadFiles(files) {
  if (!files.length || !props.project) return
  const folder = currentFolder.value

  // 立刻为每个文件生成幽灵卡
  const tasks = files.map(f => {
    const dotIdx = f.name.lastIndexOf('.')
    const ext  = dotIdx > -1 ? f.name.slice(dotIdx + 1).toUpperCase() : ''
    const name = dotIdx > -1 ? f.name.slice(0, dotIdx) : f.name
    const ghost = { uid: ++_uploadUid, name, ext, progress: 0, error: false }
    uploadingItems.value.push(ghost)
    return { file: f, ghost }
  })

  await Promise.allSettled(tasks.map(async ({ file, ghost }) => {
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('space', 'project')
      form.append('project_id', props.project.id)
      if (folder) form.append('folder_id', folder.id)
      const created = await uploadWithProgress('/files', form, p => {
        const g = uploadingItems.value.find(g => g.uid === ghost.uid)
        if (g) g.progress = Math.round(p * 100)
      })
      uploadingItems.value = uploadingItems.value.filter(g => g.uid !== ghost.uid)
      if (folder) {
        folderFilesMap.value = {
          ...folderFilesMap.value,
          [folder.id]: [created, ...(folderFilesMap.value[folder.id] ?? [])],
        }
        const fd = projectFolders.value.find(fd => fd.id === folder.id)
        if (fd) fd.fileCount = (fd.fileCount ?? 0) + 1
      } else {
        projectFiles.value.unshift(created)
      }
    } catch (e) {
      console.error('[ProjectModal] 上传失败:', e.message)
      ghost.error = true
      setTimeout(() => {
        uploadingItems.value = uploadingItems.value.filter(g => g.uid !== ghost.uid)
      }, 2000)
    }
  }))
}

async function handleFileInput(e) {
  await uploadFiles([...e.target.files])
  e.target.value = ''
}

async function handleFileDrop(e) {
  dragging.value = false
  await uploadFiles([...(e.dataTransfer?.files ?? [])])
}

function onPmDragEnter(e) {
  if (e.dataTransfer?.types?.includes('Files')) pmDragCounter.value++
}
function onPmDragLeave() {
  pmDragCounter.value = Math.max(0, pmDragCounter.value - 1)
}
async function onPmDrop(e) {
  pmDragCounter.value = 0
  const files = [...(e.dataTransfer?.files ?? [])]
  if (files.length) await uploadFiles(files)
}

// ── 剪贴板 & 右键菜单（ProjectModal）──────────────────────────────────────────
const isMac = navigator.platform.toUpperCase().includes('MAC') || navigator.userAgent.includes('Mac')
const modKey = isMac ? '⌘' : 'Ctrl'
const pmCbStore = useClipboardStore()

function pmSelCut() {
  pmCbStore.cut([...pmSelectedFileIds.value], [...pmSelectedFolderIds.value])
  clearPmSelection()
}
function pmSelCopy() {
  pmCbStore.copy([...pmSelectedFileIds.value], [])
  clearPmSelection()
}
const pmCtx = ref({ visible: false, x: 0, y: 0, type: null, target: null })
const pmInfoPopup = ref({ show: false, file: null, x: 0, y: 0 })

function openPmCtx(type, target, e) {
  if (type === 'file' && target &&
      (pmSelectedFileIds.value.has(target.id) || pmSelectedFolderIds.value.size > 0) &&
      (pmSelectedFileIds.value.size + pmSelectedFolderIds.value.size) > 1) {
    type = 'multi-file'
  }
  pmCtx.value = { visible: true, x: e.clientX, y: e.clientY, type, target }
}

function pmCurrentFolderId() {
  return folderStack.value.length ? folderStack.value[folderStack.value.length - 1].id : null
}

function pmCtxInfo() {
  const f = pmCtx.value.target
  pmCtx.value.visible = false
  if (f) pmInfoPopup.value = { show: true, file: f, x: pmCtx.value.x, y: pmCtx.value.y }
}

async function pmCtxDownload() {
  pmCtx.value.visible = false
  const ids = pmCtx.value.type === 'multi-file'
    ? [...pmSelectedFileIds.value] : [pmCtx.value.target.id]
  if (ids.length === 1) {
    const f = pmCtx.value.target
    await filesApi.download(f.id, `${f.displayName}.${f.ext}`)
  } else {
    const fids = [...pmSelectedFolderIds.value]
    const dirName = folderStack.value.length
      ? folderStack.value[folderStack.value.length - 1].name
      : (projectStore.projects.find(p => p.id === selectedProjectId.value)?.name ?? '文件')
    await filesApi.batchDownload(ids, fids, `${dirName}.zip`)
  }
}
function pmCtxRename() {
  const f = pmCtx.value.target; pmCtx.value.visible = false
  startRename(f)
}
function pmCtxCut() {
  const ids = pmCtx.value.type === 'multi-file' ? [...pmSelectedFileIds.value] : [pmCtx.value.target.id]
  pmCbStore.cut(ids, []); pmCtx.value.visible = false
}
function pmCtxCopy() {
  const ids = pmCtx.value.type === 'multi-file' ? [...pmSelectedFileIds.value] : [pmCtx.value.target.id]
  pmCbStore.copy(ids, []); pmCtx.value.visible = false
}
async function pmCtxDelete() {
  const ids = pmCtx.value.type === 'multi-file' ? [...pmSelectedFileIds.value] : [pmCtx.value.target.id]
  pmCtx.value.visible = false
  await Promise.all(ids.map(id => filesApi.delete(id)))
  clearPmSelection()
  await pmRefreshCurrentFolder()
}

function pmCtxDownloadFolder() {
  const f = pmCtx.value.target; pmCtx.value.visible = false
  downloadFolderZip(f)
}
function pmCtxRenameFolder() {
  const f = pmCtx.value.target; pmCtx.value.visible = false
  startRenameFolder(f)
}
function pmCtxCutFolder() {
  pmCbStore.cut([], [pmCtx.value.target.id]); pmCtx.value.visible = false
}
async function pmCtxDeleteFolder() {
  const f = pmCtx.value.target; pmCtx.value.visible = false
  await deleteFolderCard(f)
}

async function pmRefreshCurrentFolder() {
  const pid = props.project?.id; if (!pid) return
  const stack = folderStack.value
  if (!stack.length) {
    const files = await filesApi.list({ projectId: pid })
    projectFiles.value = files.filter(f => !f.folderId)
  } else {
    const fid = stack[stack.length - 1].id
    const files = await filesApi.list({ folderId: fid })
    folderFilesMap.value = { ...folderFilesMap.value, [fid]: files }
  }
}

async function pmCtxPaste() {
  pmCtx.value.visible = false
  const folderId  = pmCurrentFolderId()
  const projectId = props.project?.id
  try {
    if (pmCbStore.type === 'cut') {
      await Promise.all(pmCbStore.fileIds.map(id => filesApi.update(id, { folder_id: folderId })))
      pmCbStore.clear()
    } else if (pmCbStore.type === 'copy') {
      await Promise.all(pmCbStore.fileIds.map(id =>
        filesApi.copy(id, { folder_id: folderId, project_id: projectId })
      ))
    }
    await pmRefreshCurrentFolder()
  } catch (e) { console.error('[PM] 粘贴失败:', e) }
}

function onPmKeyDown(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
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
/* modal 保留 grid 双列布局，视觉样式由 BaseModal 的 bm-card 提供 */
.modal {
  display: grid; grid-template-columns: 320px 1fr;
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
  display: flex; flex-direction: column;
  border-right: 1px solid rgba(0,0,0,0.07); overflow: hidden;
}

/* 标题 */
.proj-header {
  height: 52px; box-sizing: border-box;
  display: flex; flex-direction: column; flex-shrink: 0;
}
.header-main {
  flex: 1; display: flex; align-items: center; gap: 8px;
  padding: 0 16px; min-width: 0;
}
.header-name {
  flex: 1; font-size: 17px; font-weight: 700; color: var(--text-primary);
  cursor: text; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  line-height: 1.2;
}
.header-name-input {
  flex: 1; font-size: 17px; font-weight: 700; line-height: 1.2;
  border: 1.5px solid rgba(123,127,178,0.45); border-radius: 7px;
  background: rgba(255,255,255,0.88); outline: none;
  padding: 2px 8px; margin: -3px -9px;
  font-family: var(--font-sans); color: var(--text-primary); min-width: 0;
  box-shadow: 0 0 0 3px rgba(123,127,178,0.12);
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
}
.left-content::-webkit-scrollbar { width: 4px; }
.left-content::-webkit-scrollbar-track { background: transparent; }
.left-content::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.1); border-radius: 99px; }

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
.col-divider { border: none; border-top: 1px solid rgba(0,0,0,0.07); margin: 0; }

.field-input {
  width: 100%; padding: 9px 12px; box-sizing: border-box;
  border: 1px solid rgba(0,0,0,0.1); border-radius: 8px;
  background: rgba(255,255,255,0.6); font-size: 13px;
  font-family: var(--font-sans); color: var(--text-primary);
  outline: none; transition: border-color 0.15s, box-shadow 0.15s;
}
.field-input:hover { border-color: rgba(123,127,178,0.35); box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 0 0 3px rgba(123,127,178,0.08); }
.field-input:focus { border-color: rgba(123,127,178,0.4); box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 0 0 3px rgba(123,127,178,0.1); }
.field-input::placeholder { color: var(--text-secondary); opacity: 0.6; }

/* 状态 */
.status-group { display: flex; gap: 4px; flex-wrap: wrap; }
.status-btn {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 12px; border-radius: 20px;
  border: 1.5px solid transparent; font-size: 12px; font-weight: 600;
  cursor: pointer; font-family: var(--font-sans);
  background: rgba(0,0,0,0.04); color: var(--text-secondary);
  transition: background 0.15s, color 0.15s, border-color 0.15s; outline: none;
}
.status-btn:hover { background: rgba(0,0,0,0.07); color: var(--text-primary); }
.opt-dot { width: 6px; height: 6px; border-radius: 50%; }
.status-btn.s-pending .opt-dot { background: #d46b6b; }
.status-btn.s-active  .opt-dot { background: #c9943a; }
.status-btn.s-done    .opt-dot { background: #5a9e88; }
.status-btn.s-pending.active { background: rgba(212,107,107,0.12); border-color: rgba(212,107,107,0.5); color: #b84a4a; }
.status-btn.s-active.active  { background: rgba(201,148,58,0.12);  border-color: rgba(201,148,58,0.5);  color: #a87520; }
.status-btn.s-done.active    { background: rgba(90,158,136,0.12);  border-color: rgba(90,158,136,0.4);  color: #3a8870; }

/* 配色 */
.color-grid { display: flex; gap: 6px; flex-wrap: wrap; }
.color-chip {
  width: 22px; height: 22px; border-radius: 50%;
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
.stage-flow { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow-y: auto; padding: 2px 0 4px 0; margin-right: -10px; padding-right: 10px; }

/* 备注 */
.notes-input {
  width: 100%; border: 1px solid rgba(0,0,0,0.1); border-radius: 8px; padding: 7px 10px;
  font-size: 12px; font-family: var(--font-sans); color: var(--text-primary);
  background: rgba(255,255,255,0.72); outline: none; resize: none; line-height: 1.5;
  transition: border-color 0.15s, box-shadow 0.15s; box-sizing: border-box;
}
.notes-input:focus { border-color: rgba(123,127,178,0.4); box-shadow: 0 0 0 3px rgba(123,127,178,0.1); }
.notes-input::placeholder { color: var(--text-secondary); opacity: 0.6; }
.stage-node { display: flex; flex-direction: column; position: relative; cursor: grab; transition: opacity 0.15s; padding: 0 0 0 5px; margin-bottom: 2px; }
.stage-node.stage-dragging { opacity: 0.15; pointer-events: none; }

.node-row { display: flex; align-items: center; gap: 8px; padding: 5px 0; }
.node-circle {
  width: 22px; height: 22px; border-radius: 50%;
  border: 1.5px solid rgba(0,0,0,0.12); background: rgba(0,0,0,0.08);
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  cursor: pointer; z-index: 1;
}
.stage-node.done .node-circle { background: var(--color-success); border-color: var(--color-success); }
.stage-node.active .node-circle { border-color: transparent; }
.node-num { font-size: 10px; font-weight: 700; color: var(--text-secondary); line-height: 1; }
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
  background: rgba(255,255,255,0.8); outline: none; color: var(--text-primary); width: 110px;
  box-shadow: 0 0 0 3px rgba(123,127,178,0.12);
}
.del-stage {
  background: none; border: none; cursor: pointer; color: var(--text-secondary);
  opacity: 0; transition: opacity 0.15s; padding: 2px;
  display: flex; align-items: center; flex-shrink: 0;
}
.stage-node:hover .del-stage { opacity: 0.5; }
.del-stage:hover { opacity: 1 !important; color: var(--color-warning); }
.node-line { display: none; }
.todo-list { border-bottom: 1px solid rgba(0,0,0,0.06); }
/* 待办列表 */
.todo-list { padding: 2px 0 8px 30px; display: flex; flex-direction: column; gap: 3px; border-bottom: 1px solid rgba(0,0,0,0.06); }
.stage-node:last-child .todo-list { border-bottom: none; }
.todo-item { display: flex; align-items: center; gap: 6px; height: 24px; }
.todo-item + .todo-item { border-top: 1px solid rgba(0,0,0,0.05); }
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
  background: rgba(255,255,255,0.88);
  border-color: rgba(123,127,178,0.45);
  box-shadow: 0 0 0 3px rgba(123,127,178,0.12);
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
  border: 1px dashed rgba(0,0,0,0.15); background: rgba(255,255,255,0.5);
  font-size: 11px; font-weight: 500; color: var(--text-secondary);
  cursor: pointer; font-family: var(--font-sans); transition: all 0.15s;
  margin-top: 2px;
}
.todo-add-btn:hover { border-color: var(--color-primary); color: var(--color-primary); background: rgba(123,127,178,0.06); }



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

/* ── 右栏：文件 ── */
.modal-right { display: flex; flex-direction: column; min-height: 0; background: transparent; }
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


.file-content { flex: 1; overflow-y: auto; padding: 14px; user-select: none; position: relative; }

.file-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  grid-auto-rows: 96px;
  gap: 6px;
  align-content: start;
}

/* 文件夹卡片 */
.folder-card {
  min-height: 84px; border-radius: 10px;
  background: color-mix(in srgb, var(--fd-color) 6%, rgba(255,255,255,0.82));
  border: 1px solid color-mix(in srgb, var(--fd-color) 14%, rgba(255,255,255,0.92));
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 1px 4px rgba(80,90,110,0.05);
}
.folder-card:hover {
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 5px 14px rgba(80,90,110,0.12);
}
.fd-icon-area { flex: 1; overflow: visible; display: flex; align-items: center; justify-content: center; }
.fd-big-icon {
  width: 58px; height: 58px;
  color: var(--fd-color); opacity: 0.58;
  transform: translateY(12px);
  mask-image: linear-gradient(to bottom, black 0%, black 35%, rgba(0,0,0,0.62) 62%, rgba(0,0,0,0.22) 80%, transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, black 0%, black 35%, rgba(0,0,0,0.62) 62%, rgba(0,0,0,0.22) 80%, transparent 100%);
}
.fd-label { padding: 0 8px 8px; }
.fd-name { font-size: 10px; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-bottom: 2px; margin-bottom: -2px; }
.fd-count { font-size: 8px; color: var(--text-secondary); opacity: 0.55; margin-top: 1px; }
.fd-hover-actions {
  position: absolute; top: 5px; right: 5px; z-index: 3;
  display: flex; gap: 2px; opacity: 0; transition: opacity 0.15s;
}
.folder-card:hover .fd-hover-actions { opacity: 1; }
/* ProjectModal 卡片较小，覆盖全局默认尺寸 */
.file-card-btn { width: 17px; height: 17px; border-radius: 4px; }
.file-card-btn::after { inset: -1px; }

/* 文件卡片 */
.fc-card {
  min-height: 84px; border-radius: 10px;
  background: rgba(255,255,255,0.68);
  border: 1px solid rgba(255,255,255,0.85);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 1px 4px rgba(80,90,110,0.05);
}
.fc-card:hover {
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 5px 14px rgba(80,90,110,0.12);
}
.fc-ext-badge {
  position: absolute; top: 6px; left: 6px;
  font-size: 7.5px; font-weight: 800; letter-spacing: 0.04em;
  border-radius: 3px; padding: 1px 3px; z-index: 1;
}
.fc-icon-area { flex: 1; overflow: visible; display: flex; align-items: center; justify-content: center; }

.fc-thumb-area {
  position: relative; height: 64px; flex-shrink: 0; overflow: hidden;
  border-radius: 10px 10px 0 0; background: rgba(0,0,0,0.05);
  will-change: transform; transform: translateZ(0);
  mask-image: linear-gradient(to bottom, black 44%, transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, black 44%, transparent 100%);
}
.fc-thumb {
  position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: cover; object-position: center top; display: block;
}
.fc-thumb-tiny { filter: blur(8px); transform: scale(1.12); z-index: 1; }
.fc-thumb-full { z-index: 2; opacity: 0; transition: opacity 0.4s ease; }
.fc-thumb-full.fc-loaded { opacity: 1; }
.fc-has-thumb .fc-label { margin-top: auto; position: relative; z-index: 1; }
.fc-has-thumb .fc-ext-badge { background: rgba(0,0,0,0.32) !important; color: rgba(255,255,255,0.92) !important; }
.fc-big-icon {
  width: 58px; height: 58px;
  color: var(--fc-color); opacity: 0.55;
  transform: translateY(12px);
  mask-image: linear-gradient(to bottom, black 0%, black 35%, rgba(0,0,0,0.62) 62%, rgba(0,0,0,0.22) 80%, transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, black 0%, black 35%, rgba(0,0,0,0.62) 62%, rgba(0,0,0,0.22) 80%, transparent 100%);
}
.fc-label { padding: 0 8px 8px; }
.fc-name {
  font-size: 10px; font-weight: 600; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  padding-bottom: 2px; margin-bottom: -2px;
}
.fc-meta { font-size: 8px; color: var(--text-secondary); opacity: 0.6; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-bottom: 2px; margin-bottom: -2px; }

/* 视图切换 & 新建文件夹（header 内） */
.sort-selector { position: relative; }
.sort-btn {
  display: flex; align-items: center; gap: 4px;
  height: 28px; padding: 0 9px; border-radius: 7px; border: none;
  background: rgba(255,255,255,0.55); cursor: pointer;
  font-size: 11px; font-weight: 500; color: var(--text-secondary);
  font-family: var(--font-sans); transition: background 0.15s, color 0.15s;
}
.sort-btn:hover { background: rgba(255,255,255,0.82); color: var(--text-primary); }
.sort-dir-icon { transition: transform 0.2s; }
.sort-dir-icon.desc { transform: rotate(180deg); }
.sort-menu {
  position: absolute; top: calc(100% + 5px); left: 50%; transform: translateX(-50%); z-index: 400;
  display: flex; flex-direction: column; gap: 1px; min-width: 100px;
}
.sort-check { flex-shrink: 0; color: var(--color-primary); }
.sort-check.desc { transform: rotate(180deg); }

.view-toggle {
  display: flex; background: rgba(0,0,0,0.05);
  border-radius: 8px; padding: 2px; gap: 2px;
}
.view-toggle button {
  width: 28px; height: 28px; border-radius: 6px; border: none;
  background: none; cursor: pointer; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center; transition: all 0.15s;
}
.view-toggle button.on {
  background: rgba(255,255,255,0.85); color: var(--color-primary);
  box-shadow: 0 1px 4px rgba(0,0,0,0.08);
}
.new-folder-btn {
  display: flex; align-items: center; gap: 5px;
  height: 28px; padding: 0 11px; border-radius: 8px;
  border: 1px dashed rgba(0,0,0,0.15); background: rgba(255,255,255,0.5);
  font-size: 12px; font-weight: 500; color: var(--text-secondary);
  cursor: pointer; font-family: var(--font-sans); transition: all 0.15s; white-space: nowrap;
}
.new-folder-btn:hover { border-color: var(--color-primary); color: var(--color-primary); background: rgba(123,127,178,0.06); }
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
.fc-hover-actions { position: absolute; top: 5px; right: 5px; z-index: 3; display: flex; gap: 2px; opacity: 0; transition: opacity 0.15s; }
.fc-card:hover .fc-hover-actions { opacity: 1; }

/* ── 幽灵上传卡片 ── */
.fc-ghost {
  position: relative; min-height: 84px; overflow: hidden;
  border-radius: 10px; border: 1.5px dashed rgba(123,127,178,0.35);
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
  border-color: rgba(123,127,178,0.5);
  background: rgba(123,127,178,0.08);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.8), 0 0 0 1.5px rgba(123,127,178,0.2);
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
.lr-chev { transition: transform 0.2s; opacity: 0.5; }
.lr-chev.open { transform: rotate(180deg); }
.list-row-empty { font-size: 11px; color: var(--text-secondary); padding: 4px 28px; }
.list-upload-row {
  display: flex; align-items: center; gap: 7px; padding: 7px 10px;
  font-size: 12px; color: var(--text-secondary); cursor: pointer;
  border-radius: var(--radius-sm); transition: background 0.12s; border: 1px dashed transparent;
}
.list-upload-row:hover { background: rgba(123,127,178,0.05); border-color: rgba(123,127,178,0.3); color: var(--color-primary); }
.rename-sizer {
  display: inline-block; position: relative;
  max-width: 100%; vertical-align: top;
}
.rename-ghost {
  display: block; visibility: hidden; white-space: pre;
  font: inherit; padding: 0 5px; min-width: 2ch;
}
.rename-input-inline {
  position: absolute; inset: 0; width: 100%;
  outline: none;
  background: rgba(255,255,255,0.9); border: 1px solid rgba(123,127,178,0.4);
  border-radius: 4px; padding: 0 4px;
  font: inherit; color: inherit;
}

.fc-upload {
  border: 1.5px dashed rgba(0,0,0,0.1);
  border-radius: 10px; min-height: 84px;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 5px;
  color: var(--text-secondary); font-size: 10px;
  cursor: pointer; background: rgba(255,255,255,0.2); transition: all 0.18s;
}
.fc-upload:hover, .fc-upload.dragging {
  border-color: rgba(123,127,178,0.5);
  color: var(--color-primary); background: rgba(123,127,178,0.05);
}

/* ── 动画 ── */
</style>

<style>
.stage-drag-ghost-full {
  position: fixed; z-index: 9999; pointer-events: none;
  display: flex; align-items: center;
  padding: 5px 12px;
  background: rgba(238,240,246,0.96);
  backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(123,127,178,0.3);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(30,40,80,0.14);
  opacity: 0.95; box-sizing: border-box;
}
.stage-drag-ghost-full .node-label {
  font-size: 13px; color: #1e2028; font-weight: 500;
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* ── 右键菜单 ── */
.fc-card.cut, .list-row.cut { opacity: 0.45; }

.drop-overlay {
  position: absolute; inset: 0; z-index: 50;
  background: rgba(232,233,238,0.82);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  border-radius: inherit;
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
