<template>
  <div class="glass-card file-panel" ref="panelRef">
    <div class="section-header">
      <span class="section-title">最近文件</span>
    </div>

    <div class="file-grid">
      <div
        v-for="f in files"
        :key="f.id"
        class="fc-card"
        :class="{ 'fc-has-thumb': isImageExt(f.ext) }"
        :style="{ '--fc-color': fileIconColor(f.ext) }"
        @click="openFile(f)"
      >
        <span class="fc-ext-badge">{{ f.ext }}</span>

        <div v-if="isImageExt(f.ext)" class="fc-thumb-area">
          <img class="fc-thumb fc-thumb-tiny" :src="thumbMap[f.id]?.tiny" decoding="async" draggable="false" alt="" />
          <img class="fc-thumb fc-thumb-full"
            :src="thumbMap[f.id]?.card"
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
          <div class="fc-name" :title="f.name">
            <span v-if="renamingId === f.id" class="rename-sizer" @click.stop>
              <span class="rename-ghost">{{ renameText || ' ' }}</span>
              <input
                ref="renameInputRef"
                class="rename-input-inline"
                v-model="renameText"
                v-enter.prevent="() => commitRename(f)"
                @keydown.esc="renamingId = null"
                @blur="commitRename(f)"
                @focus="($event.target as HTMLInputElement).select()"
              />
            </span>
            <template v-else>{{ f.name }}</template>
          </div>
          <div class="fc-meta">
            <span class="fc-proj-dot" :style="{ background: f.projectColor }"></span>
            {{ f.project }} · {{ f.size }}
          </div>
        </div>

        <div class="fc-hover-actions">
          <button class="file-card-btn" :title="renamingId === f.id ? '确认' : '重命名'"
            @mousedown.prevent @click.stop="renamingId === f.id ? commitRename(f) : startRename(f)">
            <PhCheck v-if="renamingId === f.id" :size="11" weight="bold" />
            <PhPencilSimple v-else :size="11" weight="bold" />
          </button>
          <button class="file-card-btn" title="下载" @click.stop="downloadFile(f)">
            <PhDownloadSimple :size="11" weight="bold" />
          </button>
          <button class="file-card-btn del" title="移到回收站" @click.stop="deleteFile(f)">
            <PhTrash :size="11" weight="bold" />
          </button>
        </div>
      </div>

      <!-- 上传区 -->
      <label
        class="fc-upload"
        @dragover.prevent="dragging = true"
        @dragleave="dragging = false"
        @drop.prevent="dragging = false; openUpload()"
        :class="{ dragging }"
        @click.prevent="openUpload"
      >
        <svg width="20" height="20" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.4">
          <path d="M11 15V5M6 9l5-5 5 5"/><path d="M2 17h18"/>
        </svg>
        <span class="fc-upload-text">上传文件</span>
      </label>
    </div>
  </div>

  <Teleport to="body">
    <UploadModal
      :show="uploadOpen"
      :projects="projects"
      @close="uploadOpen = false"
      @uploaded="onUploaded"
    />
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, shallowRef, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { filesApi } from '@/services/api'
import { filesCache } from '@/services/cache'
import { useProjectStore } from '@/stores/projects'
import { usePreviewStore, isPreviewable } from '@/stores/preview'
import { getThumb, getCachedThumb, preloadTinyThumbs, clearThumbCache, cardBlobReadyIds } from '@/composables/useThumbCache'
import { isImageExt, fileIconColor, fileListIcon } from '@/utils/fileTypes'
import UploadModal from '@/views/Files/UploadModal.vue'
import {
  PhPencilSimple, PhCheck, PhDownloadSimple, PhTrash,
} from '@phosphor-icons/vue'

const panelRef      = ref(null)
const colCount      = ref(4) // ResizeObserver 更新后覆盖
const displayCount  = computed(() => Math.max(1, colCount.value - 1)) // 1 行，上传按钮占 1 格
const cardVisible   = ref(false) // 面板是否已进入视口（触发过 card 加载）
// 使用模块级 cardBlobReadyIds：首次 @load 后写入，session 内二次访问直接显示跳过动画
const dragging      = ref(false)
const uploadOpen    = ref(false)
const rawFiles      = ref(filesCache.data ?? [])
const thumbMap      = shallowRef<Record<number, { tiny?: string | null; card?: string | null }>>({}) // id → { tiny, card }，shallowRef 批量更新减少 trigger 次数
const renamingId    = ref(null)
const renameText    = ref('')
const renameInputRef = ref(null)
const projectStore  = useProjectStore()
const previewStore  = usePreviewStore()
const projects      = computed(() => projectStore.projects)

// 只加载 tiny，card 延迟到面板进入视口后再加载
function loadThumbs(list) {
  const imgFiles = list.filter(f => isImageExt(f.ext))
  const snap = { ...thumbMap.value }
  imgFiles.forEach(f => {
    snap[f.id] = { tiny: getCachedThumb(f.id, 'tiny'), card: thumbMap.value[f.id]?.card ?? null }
  })
  thumbMap.value = snap
  imgFiles.forEach(f => {
    if (snap[f.id]?.tiny) return
    getThumb(f.id, 'tiny').then(url => {
      if (url) thumbMap.value = { ...thumbMap.value, [f.id]: { ...thumbMap.value[f.id], tiny: url } }
    })
  })
}

// 面板进入视口后调用，加载 card 缩略图
function loadCards(list) {
  const imgFiles = list.filter(f => isImageExt(f.ext))
  const snap = { ...thumbMap.value }
  let hasNew = false
  imgFiles.forEach(f => {
    const cached = getCachedThumb(f.id, 'card')
    if (cached && snap[f.id]?.card !== cached) {
      snap[f.id] = { ...snap[f.id], card: cached }
      hasNew = true
    }
  })
  if (hasNew) { thumbMap.value = snap; preDecodeBlobs(snap) }

  const uncached = imgFiles.filter(f => !snap[f.id]?.card)
  if (uncached.length) {
    Promise.all(uncached.map(f => getThumb(f.id, 'card').then(url => ({ id: f.id, url }))))
      .then(results => {
        const m = { ...thumbMap.value }
        for (const { id, url } of results) if (url) m[id] = { ...m[id], card: url }
        thumbMap.value = m
        preDecodeBlobs(m)
      })
  }
}

function preDecodeBlobs(map: Record<number, { tiny?: string | null; card?: string | null }>) {
  for (const entry of Object.values(map)) {
    for (const url of [entry?.tiny, entry?.card]) {
      if (url) { const i = new Image(); i.src = url; i.decode().catch(() => {}) }
    }
  }
}

// 文件类型助手统一收口到 @/utils/fileTypes（isImageExt / fileIconColor / fileListIcon），见顶部 import。

function openUpload() { uploadOpen.value = true }
function openFile(f) {
  if (renamingId.value === f.id) return
  if (isPreviewable(f.ext)) previewStore.open(f._raw)
}

async function startRename(f) {
  renamingId.value = f.id
  renameText.value = f.name
  await nextTick()
  const el = renameInputRef.value?.[0] ?? renameInputRef.value
  el?.focus(); el?.select()
}

async function commitRename(f) {
  const name = renameText.value.trim()
  renamingId.value = null
  if (!name || name === f.name) return
  try {
    await filesApi.update(f.id, { displayName: name })
    const idx = rawFiles.value.findIndex(r => r.id === f.id)
    if (idx !== -1) rawFiles.value[idx] = { ...rawFiles.value[idx], displayName: name }
    filesCache.set([...rawFiles.value])
  } catch { /* ignore */ }
}

async function downloadFile(f) {
  await filesApi.download(f.id, `${f.name}.${f.ext}`)
}

async function deleteFile(f) {
  try {
    await filesApi.delete(f.id)
    clearThumbCache(f.id)
    rawFiles.value = rawFiles.value.filter(r => r.id !== f.id)
    filesCache.set([...rawFiles.value])
  } catch { /* ignore */ }
}

async function onUploaded() {
  uploadOpen.value = false
  try {
    const fresh = await filesApi.list()
    filesCache.set(fresh) // 触发 watch，rawFiles / thumbs 自动更新
  } catch { /* ignore */ }
}

// 响应 index.vue 拉取或上传后写入的新数据
// minmax(130px, 1fr) + gap:8px + padding:20px*2 → cols = floor((w - 40 + 8) / 138)
function calcCols(width) { return Math.max(1, Math.floor((width - 32) / 138)) }

watch(filesCache.ref, (list) => {
  if (!list?.length) return
  rawFiles.value = list
  preloadTinyThumbs(list)
  loadThumbs(list.slice(0, displayCount.value))
  if (cardVisible.value) loadCards(list.slice(0, displayCount.value))
})

// 面板变宽时 displayCount 增大，补加载新出现文件的缩略图
watch(displayCount, (newCount, oldCount) => {
  if (newCount <= oldCount) return
  const list = rawFiles.value
  if (!list?.length) return
  loadThumbs(list.slice(oldCount, newCount))
  if (cardVisible.value) loadCards(list.slice(oldCount, newCount))
})

let _panelObs = null
let _resizeObs = null
onMounted(() => {
  if (panelRef.value) {
    colCount.value = calcCols(panelRef.value.offsetWidth)
    _resizeObs = new ResizeObserver(([entry]) => {
      colCount.value = calcCols(entry.contentRect.width)
    })
    _resizeObs.observe(panelRef.value)
  }

  const list = filesCache.data
  if (list?.length) {
    preloadTinyThumbs(list)
    loadThumbs(list.slice(0, displayCount.value))
  }

  // card 等面板接近视口时再加载，避免屏幕外批量解码
  _panelObs = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return
    _panelObs.disconnect(); _panelObs = null
    cardVisible.value = true
    const cur = filesCache.data
    if (cur?.length) loadCards(cur.slice(0, displayCount.value))
  }, { rootMargin: '300px' })
  if (panelRef.value) _panelObs.observe(panelRef.value)
})

onUnmounted(() => {
  _panelObs?.disconnect(); _panelObs = null
  _resizeObs?.disconnect(); _resizeObs = null
})

const files = computed(() =>
  rawFiles.value.slice(0, displayCount.value).map(f => ({
    id:           f.id,
    _raw:         f,
    name:         f.displayName,
    ext:          f.ext,
    size:         f.versions?.[0]?.size ?? '—',
    project:      f.projectName ?? '未分类',
    projectColor: f.projectColor ?? '#8a8fa8',
  }))
)
</script>

<style scoped>
.file-panel { padding: 20px; flex-shrink: 0; }

.file-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 8px;
  align-content: start;
}

.fc-card {
  background: rgba(255,255,255,0.72);
  border: 1px solid rgba(255,255,255,0.9);
  border-radius: 14px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 1px 5px rgba(0,0,0,0.06);
  min-height: 110px;
  transition: box-shadow 0.25s ease;
}
.fc-card:hover { transform: none; box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 4px 12px rgba(0,0,0,0.10); }

.fc-ext-badge {
  position: absolute; top: 9px; left: 9px; z-index: 2;
  font-size: 8px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase;
  color: var(--fc-color, var(--color-primary));
  background: rgba(0,0,0,0.04);
  border-radius: 4px; padding: 2px 5px; line-height: 1.5;
}

.fc-icon-area {
  height: 80px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  overflow: visible;
}
.fc-big-icon {
  width: 80px; height: 80px;
  color: var(--fc-color, var(--color-primary));
  opacity: 0.55;
  transform: translateY(18px);
  mask-image: linear-gradient(to bottom, black 0%, black 35%, rgba(0,0,0,0.62) 62%, rgba(0,0,0,0.22) 80%, transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, black 0%, black 35%, rgba(0,0,0,0.62) 62%, rgba(0,0,0,0.22) 80%, transparent 100%);
  flex-shrink: 0;
}

.fc-thumb-area {
  position: relative; height: 80px; flex-shrink: 0; overflow: hidden;
  border-radius: 14px 14px 0 0; background: rgba(0,0,0,0.05);
  mask-image: linear-gradient(to bottom, black 48%, transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, black 48%, transparent 100%);
}
.fc-thumb {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  object-fit: cover; object-position: center top; display: block;
}
.fc-thumb-tiny { filter: blur(10px); }
.fc-thumb-full { opacity: 0; transition: opacity 0.4s ease; }
.fc-thumb-full.fc-loaded { opacity: 1; }
.fc-has-thumb .fc-ext-badge { background: rgba(0,0,0,0.32); color: rgba(255,255,255,0.92); }

.fc-label { padding: 0 11px 11px; position: relative; z-index: 2; }
.fc-name {
  font-size: 11px; font-weight: 600; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  line-height: 1.35; padding-bottom: 2px; margin-bottom: -2px;
}
.fc-meta {
  display: flex; align-items: center; gap: 4px;
  font-size: 9px; color: var(--text-secondary); opacity: 0.55; margin-top: 3px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.fc-proj-dot {
  width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; opacity: 0.8;
}

.fc-upload {
  min-height: 110px; border-radius: 14px;
  border: 1.5px dashed rgba(0,0,0,0.1);
  display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 6px;
  color: var(--text-secondary); cursor: pointer;
  background: rgba(255,255,255,0.2);
  transition: all 0.18s;
}
.fc-upload:hover, .fc-upload.dragging {
  border-color: rgba(123,127,178,0.45);
  color: var(--color-primary);
  background: rgba(123,127,178,0.04);
}
.fc-upload-text { font-size: 10px; font-weight: 600; }

.fc-hover-actions {
  position: absolute; top: 8px; right: 8px; z-index: 3;
  display: flex; gap: 3px; opacity: 0; transition: opacity 0.15s;
}
.fc-card:hover .fc-hover-actions { opacity: 1; }

/* .rename-sizer / .rename-ghost / .rename-input-inline 已提到 global.css（全站重命名输入框共用） */
</style>
