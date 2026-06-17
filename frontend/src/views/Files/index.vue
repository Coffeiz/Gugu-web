<template>
  <div class="files-page" @click="onPageClick">

    <!-- 工具栏 -->
    <div class="files-toolbar glass-card" @click.stop>

      <!-- 面包屑导航 -->
      <div class="breadcrumb">
        <button class="bc-item" :class="{ active: navPath.length === 0 }" @click="navigateTo(-1)">
          <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <path d="M2 7h10M7 2l5 5-5 5"/>
          </svg>
          全部文件
        </button>
        <template v-for="(seg, i) in navPath" :key="i">
          <svg class="bc-arrow" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <path d="M3 2l4 3-4 3"/>
          </svg>
          <button class="bc-item" :class="{ active: i === navPath.length - 1 }" @click="navigateTo(i)">
            <span v-if="seg.color" class="bc-dot" :style="{ background: seg.color }"></span>
            {{ seg.name }}
          </button>
        </template>
      </div>

      <div class="toolbar-right">
        <!-- 视图切换（回收站不需要） -->
        <div v-if="currentType !== 'trash'" class="view-toggle">
          <button :class="{ on: viewMode === 'grid' }" @click="viewMode = 'grid'" title="网格视图">
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
              <rect x="1" y="1" width="5" height="5" rx="1.2"/>
              <rect x="8" y="1" width="5" height="5" rx="1.2"/>
              <rect x="1" y="8" width="5" height="5" rx="1.2"/>
              <rect x="8" y="8" width="5" height="5" rx="1.2"/>
            </svg>
          </button>
          <button :class="{ on: viewMode === 'list' }" @click="viewMode = 'list'" title="列表视图">
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
              <path d="M1 3h12M1 7h12M1 11h12"/>
            </svg>
          </button>
        </div>

        <!-- 新建文件夹（个人层和项目层） -->
        <template v-if="currentType === 'personal' || currentType === 'project'">
          <div v-if="showNewFolderInput" class="new-folder-row" @click.stop>
            <input
              class="new-folder-input"
              v-model="newFolderName"
              placeholder="文件夹名称"
              @keyup.enter="createFolder"
              @keyup.esc="showNewFolderInput = false; newFolderName = ''"
              ref="folderInputRef"
            />
            <button class="btn-confirm" :disabled="newFolderLoading" @click="createFolder">确定</button>
            <button class="btn-cancel" @click="showNewFolderInput = false; newFolderName = ''">✕</button>
          </div>
          <button v-else class="new-folder-btn" @click.stop="showNewFolderInput = true">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M2 4a1 1 0 011-1h2.5l1 1.5H11a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1V4z"/>
              <path d="M7 7v3M5.5 8.5h3"/>
            </svg>
            新建文件夹
          </button>
        </template>

        <!-- 清空回收站 -->
        <button v-if="currentType === 'trash'" class="empty-trash-btn" @click.stop="confirmEmptyTrash">
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 4h10M5 4V3h4v1M6 7v3M8 7v3M3 4l.7 7.3A1 1 0 004.7 12h4.6a1 1 0 001-.7L11 4"/>
          </svg>
          清空回收站
        </button>

        <!-- 上传按钮 -->
        <button v-if="currentType !== 'trash'" class="upload-btn" @click="openUploadDialog">
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M7 10V3M4 6l3-3 3 3"/><path d="M1 12h12"/>
          </svg>
          上传文件
        </button>
      </div>
    </div>

    <!-- 内容区 -->
    <div class="files-body">
      <div class="files-main glass-card" ref="mainRef"
        :class="{ 'is-selecting': boxStart !== null }"
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

        <!-- ── 回收站视图 ── -->
        <template v-if="currentType === 'trash'">
          <div v-if="contents.files.length > 0" class="trash-list">
            <div class="trash-head">
              <span>名称</span>
              <span>删除时间</span>
              <span>剩余天数</span>
              <span>大小</span>
              <span></span>
            </div>
            <div v-for="f in contents.files" :key="f.id" class="trash-row">
              <span class="lr-name-cell">
                <span class="lr-ext">{{ f.ext }}</span>
                <span class="lr-filename">{{ f.displayName }}</span>
              </span>
              <span class="lr-text">{{ f.deletedAt ? formatDate(f.deletedAt) : '—' }}</span>
              <span class="lr-text" :class="{ 'days-warn': daysLeft(f.deletedAt) <= 3 }">
                {{ daysLeft(f.deletedAt) }} 天
              </span>
              <span class="lr-text">{{ f.size }}</span>
              <span class="trash-actions">
                <button class="trash-restore-btn" title="恢复文件" @click.stop="restoreFile(f)">
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M2 7A5 5 0 1 0 7 2"/><path d="M2 2v5h5"/>
                  </svg>
                  恢复
                </button>
                <button class="trash-del-btn" title="永久删除" @click.stop="hardDeleteFile(f)">
                  <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M2 4h10M5 4V3h4v1M6 7v3M8 7v3M3 4l.7 7.3A1 1 0 004.7 12h4.6a1 1 0 001-.7L11 4"/>
                  </svg>
                </button>
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
          <div class="file-grid">

            <!-- 文件夹卡片 -->
            <div
              v-for="f in contents.folders"
              :key="f.id"
              class="folder-card"
              :class="{ selected: selectedFolderKeys.has(f.id), 'pre-selected': previewFolderKeys.has(f.id) }"
              :data-folder-key="f.id"
              @click.stop="enterFolder(f)"
            >
              <div class="fd-icon-wrap" :style="folderIconStyle(f)">
                <svg v-if="f.type === 'personal'" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="8" r="3.5"/><path d="M4 19c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/>
                </svg>
                <svg v-else-if="f.type === 'projects'" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/>
                  <path d="M12 12v4M10 14h4"/>
                </svg>
                <svg v-else-if="f.type === 'trash'" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 6h18M8 6V4h8v2M19 6l-1.5 14a2 2 0 01-2 1.8H8.5a2 2 0 01-2-1.8L5 6"/>
                  <path d="M10 11v6M14 11v6"/>
                </svg>
                <!-- 年份文件夹 -->
                <svg v-else-if="f.type === 'year'" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>
                  <path d="M8 14h2M14 14h2M8 18h2M14 18h2"/>
                </svg>
                <!-- 月份文件夹 -->
                <svg v-else-if="f.type === 'month'" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>
                  <circle cx="12" cy="15" r="2.5" fill="currentColor" stroke="none" opacity="0.6"/>
                </svg>
                <svg v-else width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>
                </svg>
              </div>
              <div class="fd-body">
                <div class="fd-name">{{ f.displayName }}</div>
                <div class="fd-count">{{ f.count != null ? f.count + ' 个文件' : '—' }}</div>
              </div>
            </div>

            <!-- 文件卡片 -->
            <div
              v-for="f in contents.files"
              :key="f.id"
              class="fc-card"
              :class="{ selected: selectedIds.has(f.id), 'pre-selected': previewFileIds.has(f.id) }"
              :data-file-id="f.id"
              @click.stop="toggleFileSelect(f.id, $event)"
            >
              <div class="fc-top">
                <div class="fc-top-left">
                  <span class="fc-ext">{{ f.ext }}</span>
                </div>
                <span v-if="f.projectColor" class="fc-dot" :style="{ background: f.projectColor }"></span>
              </div>
              <div class="fc-name">{{ f.displayName }}</div>
              <span v-if="f.stageName" class="fc-stage-tag">{{ f.stageName }}</span>
              <div class="fc-meta">{{ f.size }} · {{ f.createdAt }}</div>
              <div class="fc-hover-actions">
                <button class="fc-action-btn" title="下载" @click.stop="downloadFile(f)">
                  <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M7 2v7M4 6l3 3 3-3"/><path d="M2 11h10"/>
                  </svg>
                </button>
                <button class="fc-action-btn fc-del-btn" title="移到回收站" @click.stop="deleteSingleFile(f)">
                  <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M2 4h10M5 4V3h4v1M6 7v3M8 7v3M3 4l.7 7.3A1 1 0 004.7 12h4.6a1 1 0 001-.7L11 4"/>
                  </svg>
                </button>
              </div>
            </div>

            <!-- 上传快捷区 -->
            <div class="fc-upload" @click.stop="openUploadDialog">
              <svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 12V3M5 7l4-4 4 4"/><path d="M2 14h14"/>
              </svg>
              <span>上传文件</span>
            </div>
          </div>

          <div v-if="contents.folders.length === 0 && contents.files.length === 0 && !loading" class="grid-empty">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="0.3">
              <path d="M4 9a2 2 0 012-2h5l2 2h10a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V9z"/>
            </svg>
            暂无文件
          </div>
        </template>

        <!-- ── 列表视图 ── -->
        <template v-else>
          <div class="file-list">
            <div class="list-head">
              <span>名称</span>
              <span>项目 / 阶段</span>
              <span>大小</span>
              <span>日期</span>
              <span></span>
            </div>

            <div
              v-for="f in contents.folders"
              :key="f.id"
              class="list-row folder-row"
              :class="{ selected: selectedFolderKeys.has(f.id), 'pre-selected': previewFolderKeys.has(f.id) }"
              :data-folder-key="f.id"
              @click.stop="enterFolder(f)"
            >
              <span class="lr-name-cell">
                <svg class="lr-folder-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" :style="{ color: folderAccentColor(f) }">
                  <path v-if="f.type === 'projects'" d="M2 5a2 2 0 012-2h8a2 2 0 012 2v7a2 2 0 01-2 2H4a2 2 0 01-2-2V5zM8 8v3M7 9.5h2"/>
                  <path v-else d="M2 5a2 2 0 012-2h2.5l1.5 2H12a2 2 0 012 2v5a2 2 0 01-2 2H4a2 2 0 01-2-2V5z"/>
                </svg>
                <span class="lr-filename">{{ f.displayName }}</span>
              </span>
              <span class="lr-text">—</span>
              <span class="lr-text">{{ f.count != null ? f.count + ' 项' : '—' }}</span>
              <span class="lr-text">—</span>
              <span></span>
            </div>

            <div
              v-for="f in contents.files"
              :key="f.id"
              class="list-row"
              :class="{ selected: selectedIds.has(f.id), 'pre-selected': previewFileIds.has(f.id) }"
              :data-file-id="f.id"
              @click.stop="toggleFileSelect(f.id, $event)"
            >
              <span class="lr-name-cell">
                <span class="lr-ext">{{ f.ext }}</span>
                <span class="lr-filename">{{ f.displayName }}</span>
              </span>
              <span class="lr-proj-cell">
                <span v-if="f.projectColor" class="lr-dot" :style="{ background: f.projectColor }"></span>
                <span class="lr-projname">{{ f.projectName || f.stageName || '—' }}</span>
              </span>
              <span class="lr-text">{{ f.size }}</span>
              <span class="lr-text">{{ f.createdAt }}</span>
              <span class="lr-actions">
                <button class="lr-action-btn" title="下载" @click.stop="downloadFile(f)">
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M7 2v7M4 6l3 3 3-3"/><path d="M2 11h10"/>
                  </svg>
                </button>
                <button class="lr-action-btn lr-del-btn" title="移到回收站" @click.stop="deleteSingleFile(f)">
                  <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M2 4h10M5 4V3h4v1M6 7v3M8 7v3M3 4l.7 7.3A1 1 0 004.7 12h4.6a1 1 0 001-.7L11 4"/>
                  </svg>
                </button>
              </span>
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
    </div>

    <!-- 批量操作浮动栏 -->
    <Transition name="action-bar">
      <div v-if="selectedIds.size > 0 || selectedFolderKeys.size > 0" class="selection-bar" @click.stop>
        <span class="sel-count">已选 {{ selectedIds.size + selectedFolderKeys.size }} 项</span>
        <button v-if="selectedIds.size > 0" class="sel-delete-btn" @click="deleteSelected">
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 4h10M5 4V3h4v1M6 7v3M8 7v3M3 4l.7 7.3A1 1 0 004.7 12h4.6a1 1 0 001-.7L11 4"/>
          </svg>
          移到回收站
        </button>
        <button class="sel-cancel-btn" @click="clearSelection">取消</button>
      </div>
    </Transition>

    <UploadModal
      :show="uploadDialogOpen"
      :projects="allProjects"
      :locked-project-id="uploadLockedProjectId"
      :locked-project-name="uploadLockedProjectName"
      :locked-color="uploadLockedColor"
      :locked-folder-id="uploadLockedFolderId"
      :initial-files="droppedFiles"
      @close="closeUploadDialog"
      @uploaded="onUploaded"
    />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { filesApi, foldersApi, trashApi } from '@/services/api'
import { uploadSignal } from '@/services/cache'
import { useProjectStore } from '@/stores/projects'
import UploadModal from './UploadModal.vue'

const projectStore = useProjectStore()

// ── 视图状态 ──
const viewMode    = ref('grid')
const loading     = ref(false)
const dragCounter = ref(0)
const isDragging  = computed(() => dragCounter.value > 0)
const mainRef     = ref(null)

// ── 导航 ──
const navPath = ref([])

const currentType = computed(() => {
  if (navPath.value.length === 0) return 'root'
  return navPath.value[navPath.value.length - 1].type
})

const currentSeg  = computed(() => navPath.value[navPath.value.length - 1] ?? null)
const projectSeg  = computed(() => navPath.value.find(s => s.type === 'project') ?? null)

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
  } else if (folder.type === 'year') {
    navPath.value = [
      { type: 'projects', name: '项目文件', color: null },
      { type: 'year', name: folder.year + ' 年', year: folder.year, color: null },
    ]
  } else if (folder.type === 'month') {
    const yearSeg = navPath.value.find(s => s.type === 'year')
    navPath.value = [
      { type: 'projects', name: '项目文件', color: null },
      { type: 'year',  name: yearSeg.year + ' 年', year: yearSeg.year, color: null },
      { type: 'month', name: parseInt(folder.month) + ' 月', year: folder.year, month: folder.month, color: null },
    ]
  } else if (folder.type === 'project') {
    // 保留年月上下文
    const path = [{ type: 'projects', name: '项目文件', color: null }]
    const yearSeg  = navPath.value.find(s => s.type === 'year')
    const monthSeg = navPath.value.find(s => s.type === 'month')
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

// ── 内容 ──
const tree     = ref(null)
const contents = ref({ folders: [], files: [] })

function extractColor(colorStr) {
  if (!colorStr) return null
  const m = colorStr.match(/#[0-9a-fA-F]{3,6}/)
  return m ? m[0] : colorStr
}

// 项目的年月来自 startDate，fallback 到 createdAt
function projYear(p)  { return (p.startDate || p.createdAt || '').slice(0, 4) || '未归类' }
function projMonth(p) { return (p.startDate || p.createdAt || '').slice(5, 7) || '00' }

async function loadContents() {
  loading.value = true
  const type = currentType.value

  try {
    if (type === 'root') {
      contents.value = {
        folders: [
          { id: 'personal', type: 'personal', displayName: '个人文件', count: tree.value?.personalCount ?? null },
          { id: 'projects', type: 'projects', displayName: '项目文件', count: projectStore.projects.length },
          { id: 'trash',    type: 'trash',    displayName: '回收站',   count: null },
        ],
        files: [],
      }
      return
    }

    if (type === 'trash') {
      const files = await trashApi.list()
      contents.value = { folders: [], files }
      return
    }

    if (type === 'personal') {
      const [apiFolders, rootFiles] = await Promise.all([
        foldersApi.list(null),
        filesApi.list({ space: 'personal' }),
      ])
      const folderItems = apiFolders.map(f => ({
        id: `f:${f.id}`, type: 'folder', folderId: f.id,
        displayName: f.name, color: null, space: 'personal',
        count: f.fileCount,
      }))
      contents.value = { folders: folderItems, files: rootFiles }
      return
    }

    if (type === 'projects') {
      // 按年分组，使用 startDate 优先，fallback 到 createdAt
      const yearMap = {}
      for (const p of projectStore.projects) {
        const year = projYear(p)
        if (!yearMap[year]) yearMap[year] = 0
        yearMap[year]++
      }
      const yearFolders = Object.keys(yearMap)
        .sort((a, b) => b.localeCompare(a))
        .map(y => ({
          id: `y:${y}`, type: 'year',
          displayName: y + ' 年',
          year: y, count: yearMap[y],
        }))
      contents.value = { folders: yearFolders, files: [] }
      return
    }

    if (type === 'year') {
      const { year } = currentSeg.value
      const monthMap = {}
      for (const p of projectStore.projects) {
        if (projYear(p) !== year) continue
        const m = projMonth(p)
        if (!monthMap[m]) monthMap[m] = 0
        monthMap[m]++
      }
      const monthFolders = Object.keys(monthMap)
        .sort()
        .map(m => ({
          id: `m:${year}-${m}`, type: 'month',
          displayName: parseInt(m) + ' 月',
          year, month: m, count: monthMap[m],
        }))
      contents.value = { folders: monthFolders, files: [] }
      return
    }

    if (type === 'month') {
      const { year, month } = currentSeg.value
      const projs = projectStore.projects.filter(p => projYear(p) === year && projMonth(p) === month)
      const projectFolders = projs.map(p => ({
        id: `p:${p.id}`, type: 'project', displayName: p.name,
        color: extractColor(p.color), projectId: p.id,
        count: tree.value?.projects?.find(t => t.id === p.id)?.totalCount ?? null,
      }))
      contents.value = { folders: projectFolders, files: [] }
      return
    }

    if (type === 'project') {
      const seg = currentSeg.value
      const [apiFolders, rootFiles] = await Promise.all([
        foldersApi.list(seg.id),
        filesApi.list({ space: 'project', projectId: seg.id }),
      ])
      const folderItems = apiFolders.map(f => ({
        id: `f:${f.id}`, type: 'folder', folderId: f.id,
        displayName: f.name, color: seg.color, projectId: seg.id,
        count: f.fileCount,
      }))
      contents.value = { folders: folderItems, files: rootFiles }
      return
    }

    if (type === 'folder') {
      const seg = currentSeg.value
      const files = await filesApi.list({ folderId: seg.folderId })
      contents.value = { folders: [], files }
      return
    }
  } catch (e) {
    console.error('[Files]', e.message)
  } finally {
    loading.value = false
  }
}

async function loadTree() {
  try {
    tree.value = await filesApi.tree()
  } catch (e) {
    console.error('[Files] 加载树失败:', e.message)
  }
}

onMounted(async () => {
  await Promise.all([
    projectStore.projects.length === 0 ? projectStore.fetchProjects?.() : Promise.resolve(),
    loadTree(),
  ])
  restoreNav()
  loadContents()
})

watch(uploadSignal, async () => {
  await loadTree()
  loadContents()
})

// ── 框选 ──
const selectedIds        = ref(new Set())
const selectedFolderKeys = ref(new Set())
const previewFileIds     = ref(new Set())
const previewFolderKeys  = ref(new Set())
const boxStart           = ref(null)
const boxEnd             = ref(null)
let   _cRect             = null

function clearSelection() {
  selectedIds.value        = new Set()
  selectedFolderKeys.value = new Set()
}

const selectionRect = computed(() => {
  if (!boxStart.value || !boxEnd.value) return null
  const x1 = Math.min(boxStart.value.x, boxEnd.value.x)
  const x2 = Math.max(boxStart.value.x, boxEnd.value.x)
  const y1 = Math.min(boxStart.value.y, boxEnd.value.y)
  const y2 = Math.max(boxStart.value.y, boxEnd.value.y)
  if (x2 - x1 < 3 && y2 - y1 < 3) return null
  return { left: x1, top: y1, width: x2 - x1, height: y2 - y1 }
})

function onMainMouseDown(e) {
  if (e.button !== 0) return
  if (e.target.closest('button, .folder-card, .fc-upload, .trash-row')) return
  if (currentType.value === 'root' || currentType.value === 'projects') return

  _cRect = mainRef.value.getBoundingClientRect()
  const scrollTop = mainRef.value.scrollTop
  boxStart.value = { x: e.clientX - _cRect.left, y: e.clientY - _cRect.top + scrollTop }
  boxEnd.value   = { ...boxStart.value }

  document.addEventListener('mousemove', onDocMouseMove)
  document.addEventListener('mouseup',   onDocMouseUp)
}

function onDocMouseMove(e) {
  if (!_cRect) return
  const scrollTop = mainRef.value.scrollTop
  boxEnd.value = {
    x: e.clientX - _cRect.left,
    y: e.clientY - _cRect.top + scrollTop,
  }
  updatePreview()
}

function onDocMouseUp(e) {
  document.removeEventListener('mousemove', onDocMouseMove)
  document.removeEventListener('mouseup',   onDocMouseUp)

  if (selectionRect.value) {
    const { fileIds, folderKeys } = getItemsInBox()
    selectedIds.value        = fileIds
    selectedFolderKeys.value = folderKeys
  } else if (!e.ctrlKey && !e.metaKey) {
    clearSelection()
  }

  previewFileIds.value    = new Set()
  previewFolderKeys.value = new Set()
  boxStart.value = null
  boxEnd.value   = null
  _cRect         = null
}

function getItemsInBox() {
  const rect = selectionRect.value
  if (!rect || !mainRef.value) return { fileIds: new Set(), folderKeys: new Set() }
  const cRect      = mainRef.value.getBoundingClientRect()
  const scrollTop  = mainRef.value.scrollTop
  const fileIds    = new Set()
  const folderKeys = new Set()
  mainRef.value.querySelectorAll('[data-file-id], [data-folder-key]').forEach(el => {
    const er  = el.getBoundingClientRect()
    const elL = er.left - cRect.left
    const elT = er.top  - cRect.top + scrollTop
    const elR = elL + er.width
    const elB = elT + er.height
    if (elL < rect.left + rect.width && elR > rect.left &&
        elT < rect.top  + rect.height && elB > rect.top) {
      if (el.dataset.fileId)    fileIds.add(Number(el.dataset.fileId))
      if (el.dataset.folderKey) folderKeys.add(el.dataset.folderKey)
    }
  })
  return { fileIds, folderKeys }
}

function updatePreview() {
  if (!selectionRect.value) {
    previewFileIds.value    = new Set()
    previewFolderKeys.value = new Set()
    return
  }
  const { fileIds, folderKeys } = getItemsInBox()
  previewFileIds.value    = fileIds
  previewFolderKeys.value = folderKeys
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
  clearSelection()
}

// ── 删除 ──
async function deleteSingleFile(f) {
  try {
    await filesApi.delete(f.id)
    selectedIds.value = new Set([...selectedIds.value].filter(id => id !== f.id))
    await loadTree()
    loadContents()
  } catch (e) {
    console.error('[Files] 删除失败:', e.message)
  }
}

async function deleteSelected() {
  if (selectedIds.value.size === 0) return
  try {
    await filesApi.batchDelete([...selectedIds.value])
    selectedIds.value = new Set()
    await loadTree()
    loadContents()
  } catch (e) {
    console.error('[Files] 批量删除失败:', e.message)
  }
}

// ── 回收站操作 ──
async function restoreFile(f) {
  try {
    await trashApi.restore(f.id)
    loadContents()
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
  const gone = Math.floor((Date.now() - new Date(deletedAt)) / 86400000)
  return Math.max(0, 30 - gone)
}

function formatDate(iso) {
  return iso ? iso.slice(0, 10) : '—'
}

// ── 上传 ──
const allProjects             = computed(() => projectStore.projects)
const uploadDialogOpen        = ref(false)
const uploadLockedProjectId   = ref(null)
const uploadLockedProjectName = ref('')
const uploadLockedColor       = ref('')
const uploadLockedFolderId    = ref(null)
const droppedFiles            = ref([])

// ── 新建文件夹 ──
const newFolderName      = ref('')
const newFolderLoading   = ref(false)
const showNewFolderInput = ref(false)

async function createFolder() {
  const name = newFolderName.value.trim()
  if (!name) return
  const projectId = currentType.value === 'project' ? projectSeg.value?.id ?? null : null
  newFolderLoading.value = true
  try {
    await foldersApi.create(projectId, name)
    newFolderName.value = ''
    showNewFolderInput.value = false
    loadContents()
  } catch (e) {
    console.error('[Files] 新建文件夹失败:', e.message)
  } finally {
    newFolderLoading.value = false
  }
}

function openUploadDialog() {
  const type = currentType.value
  const seg  = currentSeg.value

  if (type === 'project' && seg) {
    uploadLockedProjectId.value   = seg.id
    uploadLockedProjectName.value = seg.name
    uploadLockedColor.value       = seg.color ?? ''
    uploadLockedFolderId.value    = null
  } else if (type === 'folder' && seg) {
    const ps = projectSeg.value
    uploadLockedProjectId.value   = seg.projectId
    uploadLockedProjectName.value = ps?.name ?? ''
    uploadLockedColor.value       = seg.color ?? ''
    uploadLockedFolderId.value    = seg.folderId
  } else {
    uploadLockedProjectId.value   = null
    uploadLockedProjectName.value = ''
    uploadLockedColor.value       = ''
    uploadLockedFolderId.value    = null
  }
  uploadDialogOpen.value = true
}

async function onUploaded() {
  uploadDialogOpen.value = false
  droppedFiles.value = []
  await loadTree()
  await nextTick()
  loadContents()
}

function closeUploadDialog() {
  uploadDialogOpen.value = false
  droppedFiles.value = []
}

// ── 拖拽上传 ──
function onDragEnter(e) {
  if (e.dataTransfer?.types?.includes('Files')) dragCounter.value++
}
function onDragLeave() {
  dragCounter.value = Math.max(0, dragCounter.value - 1)
}
function handleDrop(e) {
  dragCounter.value = 0
  const files = [...(e.dataTransfer?.files ?? [])]
  if (files.length) {
    droppedFiles.value = files
    openUploadDialog()
  }
}

// ── 下载 ──
async function downloadFile(f) {
  try {
    await filesApi.download(f.id, `${f.displayName}.${f.ext.toLowerCase()}`)
  } catch (e) {
    console.error('[Files] 下载失败:', e.message)
  }
}

// ── 样式工具 ──
function folderIconStyle(folder) {
  if (folder.type === 'personal') return { background: 'rgba(180,148,80,0.14)',  color: '#b49450' }
  if (folder.type === 'projects') return { background: 'rgba(123,127,178,0.13)', color: '#7b7fb2' }
  if (folder.type === 'trash')    return { background: 'rgba(220,80,80,0.1)',    color: '#c85a5a' }
  if (folder.type === 'year')     return { background: 'rgba(80,160,120,0.12)',  color: '#4a9a72' }
  if (folder.type === 'month')    return { background: 'rgba(80,130,200,0.11)',  color: '#5080c8' }
  if (folder.color) {
    const c = folder.color
    return { background: `${c}22`, color: c }
  }
  return { background: 'rgba(123,127,178,0.1)', color: 'var(--color-primary)' }
}

function folderAccentColor(folder) {
  if (folder.type === 'personal') return '#b49450'
  if (folder.type === 'projects') return '#7b7fb2'
  if (folder.type === 'trash')    return '#c85a5a'
  if (folder.type === 'year')     return '#4a9a72'
  if (folder.type === 'month')    return '#5080c8'
  if (folder.color) return folder.color
  return 'var(--color-primary)'
}

const folderInputRef = ref(null)
watch(showNewFolderInput, (v) => { if (v) nextTick(() => folderInputRef.value?.focus()) })
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
  padding: 10px 16px; flex-shrink: 0; gap: 12px;
  position: relative; z-index: 20;
}
.toolbar-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

/* 面包屑 */
.breadcrumb {
  display: flex; align-items: center; gap: 4px;
  flex: 1; min-width: 0; overflow: hidden;
}
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
.bc-arrow { color: var(--text-secondary); opacity: 0.4; flex-shrink: 0; }
.bc-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }

/* 视图切换 */
.view-toggle {
  display: flex; background: rgba(0,0,0,0.05);
  border-radius: 8px; padding: 2px; gap: 2px;
}
.view-toggle button {
  width: 28px; height: 28px; border-radius: 6px; border: none;
  background: none; cursor: pointer; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  transition: all 0.15s;
}
.view-toggle button.on {
  background: rgba(255,255,255,0.85); color: var(--color-primary);
  box-shadow: 0 1px 4px rgba(0,0,0,0.08);
}

/* 新建文件夹 */
.new-folder-btn {
  display: flex; align-items: center; gap: 5px;
  padding: 6px 12px; border-radius: 8px;
  border: 1px dashed rgba(0,0,0,0.15); background: rgba(255,255,255,0.5);
  font-size: 12px; font-weight: 500; color: var(--text-secondary);
  cursor: pointer; font-family: var(--font-sans); transition: all 0.15s; white-space: nowrap;
}
.new-folder-btn:hover { border-color: var(--color-primary); color: var(--color-primary); background: rgba(123,127,178,0.06); }

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

/* 上传按钮 */
.upload-btn {
  display: flex; align-items: center; gap: 5px;
  padding: 6px 13px; border-radius: 8px; border: none;
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
  background: rgba(123,127,178,0.05);
}

/* ── 文件夹选中态 ── */
.folder-card.selected {
  border-color: rgba(123,127,178,0.6);
  background: rgba(123,127,178,0.08);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.85), 0 0 0 2px rgba(123,127,178,0.18);
}
.list-row.folder-row.selected {
  background: rgba(123,127,178,0.09);
}

/* ── 网格 ── */
.file-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 9px;
  align-content: start;
}

.grid-empty {
  display: flex; flex-direction: column; align-items: center;
  gap: 10px; padding: 72px 0;
  font-size: 12px; color: var(--text-secondary); opacity: 0.5;
}

/* ── 文件夹卡片 ── */
.folder-card {
  position: relative;
  background: rgba(255,255,255,0.62);
  border: 1px solid rgba(255,255,255,0.85);
  border-radius: var(--radius-md);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 1px 4px rgba(80,90,110,0.05);
  padding: 11px 10px 10px;
  cursor: pointer;
  display: flex; flex-direction: column; gap: 6px;
  transition: transform 0.22s cubic-bezier(0.34,1.2,0.64,1),
              box-shadow 0.22s ease, background 0.18s;
  user-select: none;
}
.folder-card:hover {
  transform: translateY(-2px);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 6px 16px rgba(80,90,110,0.1);
  background: rgba(255,255,255,0.78);
}
.folder-card:active { transform: translateY(0); }

.fd-icon-wrap {
  width: 40px; height: 38px; border-radius: 9px;
  display: flex; align-items: center; justify-content: center;
}

.fd-body { min-width: 0; }
.fd-name {
  font-size: 11px; font-weight: 600; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  line-height: 1.35;
}
.fd-count {
  font-size: 9px; color: var(--text-secondary); opacity: 0.7; margin-top: 2px;
}

/* ── 文件卡片 ── */
.fc-card {
  position: relative;
  background: rgba(255,255,255,0.68);
  border: 1.5px solid rgba(255,255,255,0.85);
  border-radius: var(--radius-md);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 1px 4px rgba(80,90,110,0.05);
  padding: 10px 10px 9px;
  display: flex; flex-direction: column; gap: 4px;
  cursor: pointer;
  transition: transform 0.25s cubic-bezier(0.34,1.2,0.64,1),
              box-shadow 0.25s ease, background 0.2s, border-color 0.2s;
}
.fc-card:hover {
  transform: translateY(-2px);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 6px 16px rgba(80,90,110,0.11);
  background: rgba(255,255,255,0.82);
}
.fc-card.selected {
  border-color: rgba(123,127,178,0.65);
  background: rgba(123,127,178,0.08);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.8), 0 0 0 2px rgba(123,127,178,0.2);
}

.fc-top { display: flex; align-items: center; justify-content: space-between; }
.fc-top-left { display: flex; align-items: center; gap: 4px; }
.fc-ext {
  font-size: 9px; font-weight: 800; letter-spacing: 0.04em;
  color: var(--color-primary); background: rgba(123,127,178,0.12);
  border-radius: 4px; padding: 2px 5px;
}
.fc-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; opacity: 0.8; }
.fc-name {
  font-size: 11px; font-weight: 600; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.3;
}
.fc-stage-tag {
  align-self: flex-start; font-size: 9px; font-weight: 600;
  color: var(--text-secondary); background: rgba(0,0,0,0.05);
  border-radius: 4px; padding: 1px 5px;
}
.fc-meta { font-size: 9px; color: var(--text-secondary); opacity: 0.7; }

.fc-hover-actions {
  position: absolute; bottom: 7px; right: 7px;
  display: flex; gap: 3px; opacity: 0; transition: opacity 0.15s;
}
.fc-card:hover .fc-hover-actions { opacity: 1; }

.fc-action-btn {
  width: 22px; height: 22px; border-radius: 6px; border: none;
  background: rgba(123,127,178,0.12); color: var(--color-primary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.15s;
}
.fc-action-btn:hover { background: rgba(123,127,178,0.22); }
.fc-del-btn { background: rgba(200,90,90,0.1); color: #c85a5a; }
.fc-del-btn:hover { background: rgba(200,90,90,0.2); }

.fc-upload {
  border: 1.5px dashed rgba(0,0,0,0.1); border-radius: var(--radius-md);
  display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 5px;
  min-height: 88px; color: var(--text-secondary); font-size: 10px;
  cursor: pointer; background: rgba(255,255,255,0.2); transition: all 0.18s;
}
.fc-upload:hover { border-color: rgba(123,127,178,0.5); color: var(--color-primary); background: rgba(123,127,178,0.05); }

/* ── 列表视图 ── */
.file-list { display: flex; flex-direction: column; }

.list-head {
  display: grid;
  grid-template-columns: 2fr 1.2fr 80px 72px 56px;
  padding: 0 10px 8px;
  font-size: 10px; font-weight: 600; color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: 0.06em;
  border-bottom: 1px solid rgba(0,0,0,0.06); margin-bottom: 2px;
}
.list-row {
  display: grid;
  grid-template-columns: 2fr 1.2fr 80px 72px 56px;
  align-items: center; padding: 9px 10px;
  border-radius: 9px; transition: background 0.12s;
  cursor: pointer;
}
.list-row:hover { background: rgba(123,127,178,0.06); }
.list-row.selected { background: rgba(123,127,178,0.1); }
.folder-row { cursor: pointer; }
.folder-row:hover { background: rgba(180,148,80,0.06); }

.lr-name-cell { display: flex; align-items: center; gap: 8px; min-width: 0; }
.lr-folder-icon { flex-shrink: 0; }
.lr-ext {
  font-size: 9px; font-weight: 800; letter-spacing: 0.04em;
  color: var(--color-primary); background: rgba(123,127,178,0.12);
  border-radius: 4px; padding: 2px 5px; flex-shrink: 0;
}
.lr-filename {
  font-size: 12px; font-weight: 600; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.lr-proj-cell { display: flex; align-items: center; gap: 6px; min-width: 0; }
.lr-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; opacity: 0.8; }
.lr-projname {
  font-size: 11px; color: var(--text-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.lr-text { font-size: 11px; color: var(--text-secondary); }

.lr-actions { display: flex; align-items: center; justify-content: flex-end; gap: 2px; }
.lr-action-btn {
  width: 24px; height: 24px; border-radius: 6px; border: none;
  background: none; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; opacity: 0; transition: opacity 0.15s, background 0.15s;
}
.list-row:hover .lr-action-btn { opacity: 1; }
.lr-action-btn:hover { background: rgba(123,127,178,0.1); color: var(--color-primary); }
.lr-del-btn:hover { background: rgba(200,90,90,0.1); color: #c85a5a; }

.list-empty {
  display: flex; flex-direction: column; align-items: center;
  gap: 8px; padding: 56px 0; color: var(--text-secondary); font-size: 12px; opacity: 0.5;
}

/* ── 回收站视图 ── */
.trash-list { display: flex; flex-direction: column; }

.trash-head {
  display: grid;
  grid-template-columns: 2fr 100px 70px 72px 120px;
  padding: 0 10px 8px;
  font-size: 10px; font-weight: 600; color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: 0.06em;
  border-bottom: 1px solid rgba(0,0,0,0.06); margin-bottom: 2px;
}
.trash-row {
  display: grid;
  grid-template-columns: 2fr 100px 70px 72px 120px;
  align-items: center; padding: 9px 10px;
  border-radius: 9px; transition: background 0.12s;
}
.trash-row:hover { background: rgba(200,90,90,0.04); }

.days-warn { color: #c85a5a; font-weight: 600; }

.trash-actions { display: flex; align-items: center; gap: 6px; }
.trash-restore-btn {
  display: flex; align-items: center; gap: 4px;
  padding: 4px 9px; border-radius: 6px; border: none;
  background: rgba(123,127,178,0.1); color: var(--color-primary);
  font-size: 11px; font-weight: 600; cursor: pointer; transition: background 0.15s;
}
.trash-restore-btn:hover { background: rgba(123,127,178,0.2); }
.trash-del-btn {
  width: 24px; height: 24px; border-radius: 6px; border: none;
  background: rgba(200,90,90,0.08); color: #c85a5a;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.15s;
}
.trash-del-btn:hover { background: rgba(200,90,90,0.18); }

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

/* ── 拖拽遮罩 ── */
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
</style>
