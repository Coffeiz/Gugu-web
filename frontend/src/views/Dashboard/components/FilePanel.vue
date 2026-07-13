<template>
  <div class="glass-card file-panel" ref="panelRef">
    <div class="section-header">
      <span class="section-title">最近文件</span>
    </div>

    <div class="file-grid">
      <FileCard
        v-for="f in files"
        :key="f.id"
        :ext="f.ext" :display-name="f.name" :has-thumb="isImageExt(f.ext)"
        :icon-size="80" :icon-lift="18" :area-height="80" :lift="false"
        @click="openFile(f)"
      >
        <template #thumb>
          <img :src="thumbMap[f.id]?.tiny ?? undefined" class="fc-thumb-tiny" decoding="async" draggable="false" alt="" />
          <img :src="thumbMap[f.id]?.card ?? undefined" class="fc-thumb-full"
            :class="{ 'fc-loaded': cardBlobReadyIds.has(f.id) }"
            decoding="async" draggable="false" alt=""
            @load="cardBlobReadyIds.add(f.id)"
            @error="($event.target as HTMLElement).style.display='none'" />
        </template>
        <template #name>
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
        </template>
        <template #meta>
          <span class="fc-proj-dot" :style="{ background: f.projectColor }"></span>
          {{ f.project }} · {{ f.size }}
        </template>

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
      </FileCard>

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
import { useFilesCacheStore } from '@/stores/filesCache'
import { useProjectStore } from '@/stores/projects'
import { usePreviewStore, isPreviewable } from '@/stores/preview'
import { getThumb, getCachedThumb, preloadTinyThumbs, clearThumbCache, cardBlobReadyIds } from '@/composables/useThumbCache'
import { isImageExt } from '@/utils/fileTypes'
import FileCard from '@/components/common/FileCard.vue'
import UploadModal from '@/views/Files/UploadModal.vue'
import {
  PhPencilSimple, PhCheck, PhDownloadSimple, PhTrash,
} from '@phosphor-icons/vue'

const panelRef      = ref<HTMLElement | null>(null)
const colCount      = ref(4) // ResizeObserver 更新后覆盖
const displayCount  = computed(() => Math.max(1, colCount.value - 1)) // 1 行，上传按钮占 1 格
const cardVisible   = ref(false) // 面板是否已进入视口（触发过 card 加载）
// 使用模块级 cardBlobReadyIds：首次 @load 后写入，session 内二次访问直接显示跳过动画
const dragging      = ref(false)
const uploadOpen    = ref(false)
// 统一到全局 filesCache store（原来是 services/cache 那第三套独立缓存）。「最近文件」= 全部文件按
// id 倒序（新文件 id 更大）取前几个。增删改走 store 增量 API，任何页面/SSE 改了 store，这里自动更新。
const store         = useFilesCacheStore()
const rawFiles      = computed(() => [...store.allFiles].sort((a, b) => b.id - a.id))
const thumbMap      = shallowRef<Record<number, { tiny?: string | null; card?: string | null }>>({}) // id → { tiny, card }，shallowRef 批量更新减少 trigger 次数
const renamingId    = ref<number | string | null>(null)
const renameText    = ref('')
const renameInputRef = ref<any>(null)
const projectStore  = useProjectStore()
const previewStore  = usePreviewStore()
const projects      = computed(() => projectStore.projects)

// 只加载 tiny，card 延迟到面板进入视口后再加载
function loadThumbs(list: any[]) {
  const imgFiles = list.filter(f => isImageExt(f.ext))
  const snap = { ...thumbMap.value }
  imgFiles.forEach(f => {
    snap[f.id] = { tiny: getCachedThumb(f.id, 'tiny'), card: thumbMap.value[f.id]?.card ?? null }
  })
  thumbMap.value = snap
  imgFiles.forEach(f => {
    if (snap[f.id]?.tiny) return
    getThumb(f.id, 'tiny').then((url: any) => {
      if (url) thumbMap.value = { ...thumbMap.value, [f.id]: { ...thumbMap.value[f.id], tiny: url } }
    })
  })
}

// 面板进入视口后调用，加载 card 缩略图
function loadCards(list: any[]) {
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
    Promise.all(uncached.map(f => getThumb(f.id, 'card').then((url: any) => ({ id: f.id, url }))))
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

// 文件类型判断统一收口到 @/utils/fileTypes（isImageExt，见顶部 import）；图标/主色现在由
// components/common/FileCard.vue 内部处理，这里不用再重复调 fileIconColor/fileListIcon。

function openUpload() { uploadOpen.value = true }
function openFile(f: any) {
  if (renamingId.value === f.id) return
  if (isPreviewable(f.ext)) previewStore.open(f._raw)
}

async function startRename(f: any) {
  renamingId.value = f.id
  renameText.value = f.name
  await nextTick()
  const el = renameInputRef.value?.[0] ?? renameInputRef.value
  el?.focus(); el?.select()
}

async function commitRename(f: any) {
  const name = renameText.value.trim()
  renamingId.value = null
  if (!name || name === f.name) return
  try {
    await filesApi.update(f.id, { displayName: name })
    store.updateFile(f.id, { displayName: name })
  } catch { /* ignore */ }
}

async function downloadFile(f: any) {
  await filesApi.download(f.id, `${f.name}.${f.ext}`)
}

async function deleteFile(f: any) {
  try {
    await filesApi.delete(f.id)
    clearThumbCache(f.id)
    store.removeFile(f.id)
  } catch { /* ignore */ }
}

async function onUploaded() {
  uploadOpen.value = false
  // 上传走 store 全量刷新拿到新文件（也会被后端 SSE 兜一次）；store 是全局单源，别处也随之更新
  store.refresh()
}

// minmax(130px, 1fr) + gap:8px + padding:20px*2 → cols = floor((w - 40 + 8) / 138)
function calcCols(width: number) { return Math.max(1, Math.floor((width - 32) / 138)) }

// rawFiles 是从 store 派生的 computed；变化时（首帧、store 刷新、SSE、别处增删改）加载缩略图。
// store 的 SSE 订阅 + visibilitychange 兜底都在 store 内部，FilePanel 不再自持刷新逻辑。
watch(rawFiles, (list) => {
  if (!list?.length) return
  preloadTinyThumbs(list)
  loadThumbs(list.slice(0, displayCount.value))
  if (cardVisible.value) loadCards(list.slice(0, displayCount.value))
}, { immediate: true })

// 面板变宽时 displayCount 增大，补加载新出现文件的缩略图
watch(displayCount, (newCount, oldCount) => {
  if (newCount <= oldCount) return
  const list = rawFiles.value
  if (!list?.length) return
  loadThumbs(list.slice(oldCount, newCount))
  if (cardVisible.value) loadCards(list.slice(oldCount, newCount))
})

let _panelObs: ResizeObserver | null = null
let _resizeObs: ResizeObserver | null = null
onMounted(() => {
  // 确保全局 store 已加载（不经文件库页也能有数据）；已加载/加载中则不重复拉。首帧缩略图由上面
  // 的 watch(rawFiles, {immediate:true}) 处理，store 数据到位后自动触发。
  if (!store.loaded && !store.loading) store.load()

  if (panelRef.value) {
    colCount.value = calcCols(panelRef.value.offsetWidth)
    _resizeObs = new ResizeObserver(([entry]) => {
      colCount.value = calcCols(entry.contentRect.width)
    })
    _resizeObs.observe(panelRef.value)
  }

  // card 等面板接近视口时再加载，避免屏幕外批量解码
  _panelObs = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return
    _panelObs?.disconnect(); _panelObs = null
    cardVisible.value = true
    const cur = rawFiles.value
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

/* .fc-card 基础视觉（底色/边框/角标/图标区/缩略图区/标题元信息）已挪进
   components/common/FileCard.vue；这里只留缩略图两层（插槽内容）、meta 里的项目色点、
   悬浮操作这几处本面板专属的部分。 */
.fc-thumb-tiny { filter: blur(10px); }
.fc-thumb-full { opacity: 0; transition: opacity 0.4s ease; }
.fc-thumb-full.fc-loaded { opacity: 1; }

/* .fc-meta 是 FileCard.vue 自己模板里包 #meta 插槽的容器 div，不是本组件插的槽内容本身
   （slot 内容才带本组件 scope），要用 :deep() 才能扎进子组件根节点以外的这层。 */
:deep(.fc-meta) {
  display: flex; align-items: center; gap: 4px;
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
