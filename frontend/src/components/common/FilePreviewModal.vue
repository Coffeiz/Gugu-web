<template>
  <Teleport to="body">
    <Transition name="fp" :duration="{ enter: 420, leave: 280 }">
      <div v-if="show && !!file" class="fp-root">
        <div class="fp-overlay" @click="$emit('close')" />
        <div class="fp-panel">
          <!-- 顶栏 -->
          <div class="fp-header">
            <div class="fp-title">
              <span class="fp-ext" :style="{ color: extColor, background: extColor + '1a' }">{{ file.ext }}</span>
              <span class="fp-name" :title="file.displayName">{{ file.displayName }}</span>
            </div>
            <div class="fp-header-actions">
              <button ref="infoBtnRef" class="fp-action-btn" :class="{ active: showInfo }" title="文件信息" @click="openInfo">
                <PhInfo weight="bold" :size="16" />
              </button>
              <button class="fp-action-btn" title="下载" @click="handleDownload">
                <PhDownloadSimple weight="bold" :size="16" />
              </button>
              <button class="fp-action-btn fp-close-btn" title="关闭 (Esc)" @click="$emit('close')">
                <PhX weight="bold" :size="16" />
              </button>
            </div>
          </div>

          <!-- 内容区 -->
          <div class="fp-body">
            <div v-if="loading" class="fp-status">
              <div class="fp-spinner"></div>
              <span>{{ converting ? '正在转换文档…' : '加载中…' }}</span>
            </div>
            <div v-else-if="error" class="fp-status fp-error">
              <PhWarningCircle :size="32" style="opacity:.5" />
              <span>{{ error }}</span>
            </div>
            <template v-else-if="blobUrl || videoSrc">
              <PdfViewer   v-if="isPdf || isOffice" :blobUrl="blobUrl" />
              <ImageViewer v-else-if="isImage"      :blobUrl="blobUrl" />
              <TextViewer  v-else-if="isText"       :blobUrl="blobUrl" :ext="file?.ext" :fileKey="file?.id ?? file?.attach_id" />
              <VideoViewer v-else-if="isVideo"      :src="videoSrc" />

            </template>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 文件信息弹窗 -->
    <Transition name="info-pop">
      <div v-if="showInfo" class="fp-info-win"
        :style="{ left: infoX+'px', top: infoY+'px' }"
        @mousedown.stop
      >
        <div class="fp-info-title" @mousedown.prevent="startInfoDrag">
          <span>文件信息</span>
          <button class="fp-action-btn fp-close-btn" @click="showInfo = false">
            <PhX weight="bold" :size="15" />
          </button>
        </div>
        <div class="fp-info-body">
          <div class="fp-info-row">
            <span class="fp-info-label">文件名</span>
            <span class="fp-info-val">{{ file.displayName }}.{{ file.ext?.toLowerCase() }}</span>
          </div>
          <div class="fp-info-row">
            <span class="fp-info-label">格式</span>
            <span class="fp-info-val">{{ file.ext?.toUpperCase() }}</span>
          </div>
          <div class="fp-info-row">
            <span class="fp-info-label">大小</span>
            <span class="fp-info-val">{{ file.size }}</span>
          </div>
          <div class="fp-info-row">
            <span class="fp-info-label">创建时间</span>
            <span class="fp-info-val">{{ file.createdAt }}</span>
          </div>
          <div v-if="file.projectName" class="fp-info-row">
            <span class="fp-info-label">所属项目</span>
            <span class="fp-info-val">{{ file.projectName }}</span>
          </div>
          <div v-if="file.folderName" class="fp-info-row">
            <span class="fp-info-label">所在文件夹</span>
            <span class="fp-info-val">{{ file.folderName }}</span>
          </div>
          <div v-if="file.stageName" class="fp-info-row">
            <span class="fp-info-label">阶段</span>
            <span class="fp-info-val">{{ file.stageName }}</span>
          </div>
          <div v-if="file.mimeType" class="fp-info-row">
            <span class="fp-info-label">MIME</span>
            <span class="fp-info-val fp-info-mono">{{ file.mimeType }}</span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, watch, computed, onUnmounted, nextTick } from 'vue'
import { PhInfo, PhDownloadSimple, PhX, PhWarningCircle } from '@phosphor-icons/vue'
import ImageViewer from '@/components/common/viewers/ImageViewer.vue'
import TextViewer  from '@/components/common/viewers/TextViewer.vue'
import { useLiveStore } from '@/stores/live'
import VideoViewer from '@/components/common/viewers/VideoViewer.vue'
import PdfViewer   from '@/components/common/viewers/PdfViewer.vue'

import { filesApi } from '@/services/api'
import { isImageExt, isTextExt, isVideoExt, isOfficeExt, isAudioExt } from '@/stores/preview'

const props = defineProps({
  show: Boolean,
  file: Object,   // { id, displayName, ext, mimeType }
})
const emit = defineEmits(['close'])

const blobUrl    = ref(null)
const videoSrc   = ref(null)
const loading    = ref(false)
const converting = ref(false)
const error      = ref(null)

const isImage  = computed(() => isImageExt(props.file?.ext))
const isText   = computed(() => isTextExt(props.file?.ext))
const isVideo  = computed(() => isVideoExt(props.file?.ext))
const isPdf    = computed(() => props.file?.ext?.toUpperCase() === 'PDF')
const isOffice = computed(() => isOfficeExt(props.file?.ext))
const isAudio  = computed(() => isAudioExt(props.file?.ext))

const EXT_COLORS = {
  PDF: '#e05555',
  DOC: '#2b7cd3', DOCX: '#2b7cd3',
  XLS: '#1d6f42', XLSX: '#1d6f42',
  PPT: '#d24726', PPTX: '#d24726',
  MP3: '#e8935a', WAV: '#e8935a', OGG: '#e8935a',
  FLAC: '#c4885a', M4A: '#e8935a', AAC: '#e8935a', OPUS: '#e8935a',
  TXT: '#7b7fb2', MD: '#7b7fb2',
  JPG: '#4caf7d', JPEG: '#4caf7d', PNG: '#4caf7d',
  GIF: '#9c6fdb', WEBP: '#4caf7d', SVG: '#f0a500',
}
const extColor = ref('#7b7fb2')

function revoke() {
  if (blobUrl.value) { URL.revokeObjectURL(blobUrl.value); blobUrl.value = null }
  videoSrc.value = null
}

async function load(file, refresh = false) {
  revoke()
  loading.value    = true
  converting.value = false
  error.value      = null
  extColor.value   = EXT_COLORS[file.ext?.toUpperCase()] ?? '#7b7fb2'

  const BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1'
  const token    = localStorage.getItem('user_token') ?? ''
  const headers  = token ? { Authorization: `Bearer ${token}` } : {}

  try {
    if (isVideoExt(file.ext)) {
      const { url } = await filesApi.getStreamUrl(file.id)
      videoSrc.value = url
    } else if (isOfficeExt(file.ext)) {
      converting.value = true
      const officeUrl = file.attach_id
        ? `${BASE_URL}/agent/attachment/${file.attach_id}/preview-pdf`
        : `${BASE_URL}/files/${file.id}/preview-pdf`
      const res = await fetch(officeUrl, { headers })
      converting.value = false
      if (!res.ok) throw new Error(`转换失败 (${res.status})`)
      let blob = await res.blob()
      // iframe 内嵌渲染要求 application/pdf，转换结果若非此类型则重包一层
      if (blob.type !== 'application/pdf') blob = new Blob([blob], { type: 'application/pdf' })
      blobUrl.value = URL.createObjectURL(blob)
    } else {
      const bust = refresh ? `?_t=${Date.now()}` : ''   // 刷新时绕开浏览器缓存，确保拿到改后的新内容
      const dlUrl = (file.attach_id
        ? `${BASE_URL}/agent/attachment/${file.attach_id}/download`
        : `${BASE_URL}/files/${file.id}/download`) + bust
      const res = await fetch(dlUrl, { headers })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      let blob = await res.blob()
      // PDF 走 iframe 原生渲染，blob 必须是 application/pdf，否则浏览器可能当下载/空白
      if (file.ext?.toUpperCase() === 'PDF' && blob.type !== 'application/pdf') {
        blob = new Blob([blob], { type: 'application/pdf' })
      }
      blobUrl.value = URL.createObjectURL(blob)
    }
  } catch (e) {
    error.value = '无法加载文件：' + e.message
  } finally {
    loading.value    = false
    converting.value = false
  }
}

watch(() => [props.show, props.file], ([show, file]) => {
  if (show && file) load(file)
  else revoke()
}, { immediate: true })

const liveStore = useLiveStore()
watch(() => liveStore.rev.files, () => {
  if (props.show && props.file && isText.value) load(props.file, true)
})

function onKey(e) { if (e.key === 'Escape') emit('close') }
watch(() => props.show, v => {
  if (v) document.addEventListener('keydown', onKey)
  else   document.removeEventListener('keydown', onKey)
}, { immediate: true })

async function handleDownload() {
  if (!props.file) return
  try {
    await filesApi.download(props.file.id, `${props.file.displayName}.${props.file.ext.toLowerCase()}`)
  } catch (e) {
    console.error('[Preview] 下载失败:', e.message)
  }
}

onUnmounted(() => {
  revoke()
  document.removeEventListener('keydown', onKey)
  window.removeEventListener('mousemove', onInfoDragMove)
  window.removeEventListener('mouseup',   onInfoDragUp)
})

// ── 文件信息弹窗 ─────────────────────────────────────────────────────────────
const showInfo   = ref(false)
const infoX      = ref(0)
const infoY      = ref(0)
const infoBtnRef = ref(null)

async function openInfo() {
  if (!showInfo.value && infoBtnRef.value) {
    await nextTick()
    const r = infoBtnRef.value.getBoundingClientRect()
    infoX.value = Math.max(8, r.right - 220)
    infoY.value = r.bottom + 6
  }
  showInfo.value = !showInfo.value
}

let infoDragOrig = null
function startInfoDrag(e) {
  if (e.button !== 0) return
  infoDragOrig = { mx: e.clientX, my: e.clientY, x: infoX.value, y: infoY.value }
  window.addEventListener('mousemove', onInfoDragMove)
  window.addEventListener('mouseup',   onInfoDragUp)
}
function onInfoDragMove(e) {
  if (!infoDragOrig) return
  infoX.value = Math.max(0, infoDragOrig.x + e.clientX - infoDragOrig.mx)
  infoY.value = Math.max(0, infoDragOrig.y + e.clientY - infoDragOrig.my)
}
function onInfoDragUp() {
  infoDragOrig = null
  window.removeEventListener('mousemove', onInfoDragMove)
  window.removeEventListener('mouseup',   onInfoDragUp)
}

// 关闭抽屉时同步关闭信息弹窗
watch(() => props.show, v => { if (!v) showInfo.value = false })
</script>

<style scoped>
/* ── 根容器 ── */
.fp-root {
  position: fixed;
  inset: 0;
  z-index: 11000;   /* 高于 GuguChat 窗口（10001/10002） */
  overflow: hidden;
  /* 整个预览模态提升为独立 GPU 合成层，防止 OOPIF（PDF iframe）的创建/销毁
     触发外层 sidebar/topbar backdrop-filter 的重合成闪烁 */
  will-change: transform;
}

/* ── 遮罩 ── */
.fp-overlay {
  position: absolute;
  inset: 0;
  background: rgba(20, 22, 30, 0.32);
  /* 保持独立合成层：opacity 过渡结束后不丢层，避免层析构时的整页重绘 */
  will-change: opacity;
}

/* ── 侧边面板 ── */
.fp-panel {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 60vw;
  background: rgba(242, 243, 248, 0.98);
  border-left: 1px solid rgba(255, 255, 255, 0.7);
  border-radius: 20px 0 0 20px;
  box-shadow: -8px 0 48px rgba(20, 25, 60, 0.18),
              inset 1px 0 0 rgba(255, 255, 255, 0.9);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  will-change: transform;
}

/* ── 顶栏 ── */
.fp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px 13px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.07);
  background: rgba(255, 255, 255, 0.6);
  flex-shrink: 0;
}
.fp-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.fp-ext {
  font-size: 8px;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  border-radius: 4px;
  padding: 2px 5px;
  flex-shrink: 0;
}
.fp-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding-bottom: 2px;
  margin-bottom: -2px;
}
.fp-header-actions { display: flex; align-items: center; gap: 0; flex-shrink: 0; }
.fp-action-btn {
  width: 30px; height: 30px; border-radius: 7px; border: none;
  background: none; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.15s, color 0.15s;
}
.fp-action-btn svg { display: block; }
.fp-action-btn:hover { background: rgba(0,0,0,0.1); color: var(--text-primary); }
.fp-close-btn:hover { background: rgba(200, 90, 90, 0.1); color: rgba(200, 90, 90, 0.9); }

/* ── 内容区 ── */
.fp-body {
  flex: 1;
  overflow: hidden;
  position: relative;
  background: rgba(230, 232, 240, 0.5);
}
.fp-iframe {
  width: 100%; height: 100%; border: none; display: block;
}

/* ── 状态占位 ── */
.fp-status {
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 12px; color: var(--text-secondary); font-size: 13px;
}
.fp-error { color: rgba(180, 80, 80, 0.8); }
.fp-spinner {
  width: 28px; height: 28px; border-radius: 50%;
  border: 2px solid rgba(123, 127, 178, 0.2);
  border-top-color: rgba(123, 127, 178, 0.7);
  animation: fp-spin 0.7s linear infinite;
}
@keyframes fp-spin { to { transform: rotate(360deg); } }

/* ── 动画 ── */
.fp-enter-active .fp-overlay {
  transition: opacity 0.32s cubic-bezier(0.4, 0, 0.2, 1);
}
.fp-leave-active .fp-overlay {
  transition: opacity 0.22s cubic-bezier(0.4, 0, 1, 1);
}
.fp-enter-from .fp-overlay,
.fp-leave-to   .fp-overlay { opacity: 0; }

/* 入场：先快后慢，带轻微弹性感 */
.fp-enter-active .fp-panel {
  transition: transform 0.42s cubic-bezier(0.16, 1, 0.3, 1);
}
/* 退场：先慢后快，加速收回 */
.fp-leave-active .fp-panel {
  transition: transform 0.26s cubic-bezier(0.4, 0, 0.8, 0.6);
}
.fp-enter-from .fp-panel,
.fp-leave-to   .fp-panel { transform: translateX(100%); }

/* ── info 按钮激活态 ── */
.fp-action-btn.active { background: rgba(123,127,178,0.15); color: var(--color-primary, #7b7fb2); }

/* ── 文件信息弹窗 ── */
.fp-info-win {
  position: fixed;
  width: 220px;
  border-radius: 12px;
  overflow: hidden;
  background: rgba(242, 243, 248, 0.97);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255,255,255,0.7);
  box-shadow: 0 8px 32px rgba(20,25,60,0.18), 0 2px 8px rgba(0,0,0,0.07);
  user-select: none;
  z-index: 11100;   /* 配合 .fp-root 抬高，信息窗仍在面板之上 */
}
.fp-info-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 10px 9px 14px;
  background: rgba(255,255,255,0.55);
  border-bottom: 1px solid rgba(0,0,0,0.07);
  cursor: grab;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}
.fp-info-title:active { cursor: grabbing; }
.fp-info-body {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 70vh;
  overflow-y: auto;
}
.fp-info-row { display: flex; flex-direction: column; gap: 2px; }
.fp-info-label {
  font-size: 10px; font-weight: 600;
  color: var(--text-secondary); opacity: .6;
  text-transform: uppercase; letter-spacing: 0.04em;
}
.fp-info-val {
  font-size: 12px; color: var(--text-primary);
  word-break: break-all; line-height: 1.4;
}
.fp-info-mono { font-family: monospace; font-size: 11px; }
.info-pop-enter-active,
.info-pop-leave-active { transition: opacity 0.12s ease, transform 0.12s ease; }
.info-pop-enter-from,
.info-pop-leave-to     { opacity: 0; transform: scale(0.95); }
</style>
