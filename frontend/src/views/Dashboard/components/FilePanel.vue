<template>
  <div class="glass-card file-panel">
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
            :class="{ 'fc-loaded': thumbMap[f.id]?.card }"
            decoding="async" draggable="false" alt=""
            @error="$event.target.style.display='none'" />
          <div class="fc-thumb-fade"></div>
        </div>
        <div v-else class="fc-icon-area">
          <component :is="fileListIcon(f.ext)" class="fc-big-icon" :size="86" weight="bold" />
        </div>

        <div class="fc-label">
          <div v-if="renamingId === f.id" class="fc-rename-wrap" @click.stop>
            <input
              ref="renameInputRef"
              class="fc-rename-input"
              v-model="renameText"
              @keydown.enter.prevent="commitRename(f)"
              @keydown.esc="renamingId = null"
              @blur="commitRename(f)"
            />
          </div>
          <div v-else class="fc-name" :title="f.name">{{ f.name }}</div>
          <div class="fc-meta">
            <span class="fc-proj-dot" :style="{ background: f.projectColor }"></span>
            {{ f.project }} · {{ f.size }}
          </div>
        </div>

        <div class="fc-hover-actions">
          <button class="fc-action-btn" title="重命名" @click.stop="startRename(f)">
            <PhPencilSimple :size="11" weight="bold" />
          </button>
          <button class="fc-action-btn" title="下载" @click.stop="downloadFile(f)">
            <PhDownloadSimple :size="11" weight="bold" />
          </button>
          <button class="fc-action-btn fc-del-btn" title="移到回收站" @click.stop="deleteFile(f)">
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

<script setup>
import { ref, computed, shallowRef, watch, onMounted, nextTick } from 'vue'
import { filesApi } from '@/services/api'
import { filesCache } from '@/services/cache'
import { useProjectStore } from '@/stores/projects'
import { usePreviewStore, isPreviewable } from '@/stores/preview'
import { getThumb, getCachedThumb, preloadTinyThumbs, clearThumbCache } from '@/composables/useThumbCache'
import UploadModal from '@/views/Files/UploadModal.vue'
import {
  PhImage, PhFilmStrip, PhMusicNote, PhTable,
  PhPresentationChart, PhArchive, PhCode, PhFileText,
  PhPencilSimple, PhDownloadSimple, PhTrash,
} from '@phosphor-icons/vue'

const dragging      = ref(false)
const uploadOpen    = ref(false)
const rawFiles      = ref(filesCache.data ?? [])
const thumbMap      = shallowRef({}) // id → { tiny, card }，shallowRef 批量更新减少 trigger 次数
const renamingId    = ref(null)
const renameText    = ref('')
const renameInputRef = ref(null)
const projectStore  = useProjectStore()
const previewStore  = usePreviewStore()
const projects      = computed(() => projectStore.projects)

function loadThumbs(list) {
  // 同步：一次性写入所有已缓存的 blob URL（1次 trigger）
  const snap = { ...thumbMap.value }
  list.forEach(f => {
    if (!isImageExt(f.ext)) return
    snap[f.id] = { tiny: getCachedThumb(f.id, 'tiny'), card: getCachedThumb(f.id, 'card') }
  })
  thumbMap.value = snap

  // 异步：全部 Promise resolve 后一次性合并（1次 trigger）
  const pending = list
    .filter(f => isImageExt(f.ext))
    .flatMap(f => [
      getThumb(f.id, 'tiny').then(url => ({ id: f.id, k: 'tiny', url })),
      getThumb(f.id, 'card').then(url => ({ id: f.id, k: 'card', url })),
    ])
  Promise.all(pending).then(results => {
    const m = { ...thumbMap.value }
    for (const { id, k, url } of results) if (url) m[id] = { ...m[id], [k]: url }
    thumbMap.value = m
  })
}

const _IMAGE_EXTS = new Set(['jpg','jpeg','png','gif','webp','avif','bmp','svg','heic','heif'])
const isImageExt  = (ext) => _IMAGE_EXTS.has((ext || '').toLowerCase())

function fileIconColor(ext) {
  const e = (ext || '').toLowerCase()
  if (['jpg','jpeg','png','gif','webp','svg','ico','bmp','avif','heic'].includes(e)) return '#b07858'
  if (['mp4','mov','avi','mkv','webm','wmv'].includes(e))                            return '#8868a0'
  if (['mp3','wav','flac','aac','ogg','m4a'].includes(e))                            return '#a07088'
  if (['pdf'].includes(e))                                                           return '#a85858'
  if (['doc','docx','rtf','odt'].includes(e))                                        return '#5078a8'
  if (['xls','xlsx','csv','ods'].includes(e))                                        return '#508870'
  if (['ppt','pptx','key','odp'].includes(e))                                        return '#a07840'
  if (['zip','rar','7z','tar','gz'].includes(e))                                     return '#808888'
  if (['js','ts','jsx','tsx','vue','py','go','rs','java','cpp','c'].includes(e))     return '#688858'
  if (['html','css','scss','json','yaml','xml','md'].includes(e))                    return '#508898'
  return '#8888a8'
}

function fileExtCategory(ext) {
  const e = (ext || '').toLowerCase()
  if (['jpg','jpeg','png','gif','webp','avif','bmp','svg','heic','heif','ico'].includes(e)) return 'image'
  if (['mp4','mov','avi','mkv','webm','wmv'].includes(e))   return 'video'
  if (['mp3','wav','flac','aac','ogg','m4a'].includes(e))   return 'audio'
  if (['xls','xlsx','csv','ods'].includes(e))               return 'sheet'
  if (['ppt','pptx','key','odp'].includes(e))               return 'slide'
  if (['zip','rar','7z','tar','gz'].includes(e))            return 'archive'
  if (['js','ts','jsx','tsx','vue','py','go','rs','java','cpp','c','cs','rb','swift','php','kt','dart','sh','html','css','scss','less','xml','json','yaml','yml','toml','md'].includes(e)) return 'code'
  return 'doc'
}

function fileListIcon(ext) {
  const cat = fileExtCategory(ext)
  if (cat === 'image')   return PhImage
  if (cat === 'video')   return PhFilmStrip
  if (cat === 'audio')   return PhMusicNote
  if (cat === 'sheet')   return PhTable
  if (cat === 'slide')   return PhPresentationChart
  if (cat === 'archive') return PhArchive
  if (cat === 'code')    return PhCode
  return PhFileText
}

function openUpload() { uploadOpen.value = true }
function openFile(f) {
  if (renamingId.value === f.id) return
  if (isPreviewable(f.ext)) previewStore.open(f._raw)
}

async function startRename(f) {
  renamingId.value = f.id
  renameText.value = f.name
  await nextTick()
  renameInputRef.value?.focus()
  renameInputRef.value?.select()
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
watch(filesCache.ref, (list) => {
  if (!list?.length) return
  rawFiles.value = list
  preloadTinyThumbs(list)
  loadThumbs(list.slice(0, 7))
})

onMounted(() => {
  const list = filesCache.data
  if (list?.length) {
    preloadTinyThumbs(list)
    loadThumbs(list.slice(0, 7))
  }
  // 不再自行调 filesApi.list()，由 index.vue 统一拉取
})

const files = computed(() =>
  rawFiles.value.slice(0, 7).map(f => ({
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
  position: relative;
  background: rgba(255,255,255,0.72);
  border: 1px solid rgba(255,255,255,0.9);
  border-radius: 14px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 1px 5px rgba(80,90,110,0.06);
  display: flex; flex-direction: column;
  min-height: 110px; overflow: hidden;
  cursor: pointer;
  transition: transform 0.25s cubic-bezier(0.34,1.2,0.64,1),
              box-shadow 0.25s ease, background 0.2s;
}
.fc-card:hover {
  will-change: transform;
  transform: translateY(-2px);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 7px 22px rgba(80,90,110,0.12);
  background: rgba(255,255,255,0.86);
}
.fc-card:active { transform: translateY(1px); opacity: 0.93; }

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
.fc-thumb-tiny { filter: blur(10px); transform: scale(1.15); z-index: 1; }
.fc-thumb-full { z-index: 2; opacity: 0; transition: opacity 0.4s ease; }
.fc-thumb-full.fc-loaded { opacity: 1; }
.fc-has-thumb .fc-ext-badge { background: rgba(0,0,0,0.32); color: rgba(255,255,255,0.92); }

.fc-label { padding: 0 11px 11px; }
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

.fc-action-btn {
  position: relative;
  width: 20px; height: 20px; border-radius: 5px; border: none;
  background: rgba(255,255,255,0.78); color: var(--text-secondary);
  backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.15s, color 0.15s;
  box-shadow: 0 1px 4px rgba(0,0,0,0.08);
}
.fc-action-btn::after { content: ''; position: absolute; inset: -2px; }
.fc-action-btn:hover { background: white; color: var(--text-primary); }
.fc-del-btn:hover { color: #e05555; }

.fc-rename-wrap { padding-bottom: 2px; }
.fc-rename-input {
  width: 100%; font-size: 11px; font-weight: 600; color: var(--text-primary);
  background: rgba(255,255,255,0.9); border: 1px solid rgba(123,127,178,0.4);
  border-radius: 4px; padding: 1px 4px; outline: none; line-height: 1.35;
}
</style>
