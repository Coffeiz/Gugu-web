<template>
  <div
    class="fpw-root"
    :class="{ 'fpw-ready': ready }"
    :style="maximized
      ? { left: 0, top: 0, width: '100vw', height: '100vh', zIndex: win.zIndex, borderRadius: 0, transition: animating ? 'left .18s ease, top .18s ease, width .18s ease, height .18s ease, border-radius .18s ease' : 'none' }
      : { left: x+'px', top: y+'px', width: w+'px', height: h+'px', zIndex: win.zIndex, transition: animating ? 'left .18s ease, top .18s ease, width .18s ease, height .18s ease, border-radius .18s ease' : 'none' }"
    @mousedown.capture="previewStore.bringToFront(win.id)"
  >
    <!-- 标题栏（拖拽区） -->
    <div class="fpw-title" :class="{ 'fpw-maximized-bar': maximized }" @mousedown.prevent="!maximized && startDrag($event)">
      <span class="fpw-ext" :style="{ color: extColor, background: extColor + '22' }">{{ win.file.ext }}</span>
      <span class="fpw-name" :title="win.file.displayName">{{ win.file.displayName }}</span>
      <div class="fpw-actions">
        <template v-if="isText">
          <button class="fpw-btn" title="缩小字号" @click.stop="textFontSize = Math.max(10, textFontSize - 1)"><PhMinus weight="bold" :size="12" /></button>
          <span class="fpw-font-size">{{ textFontSize }}</span>
          <button class="fpw-btn" title="放大字号" @click.stop="textFontSize = Math.min(24, textFontSize + 1)"><PhPlus weight="bold" :size="12" /></button>
        </template>
        <button ref="infoBtnRef" class="fpw-btn" :class="{ active: showInfo }" title="文件信息" @click.stop="openInfo">
          <PhInfo weight="bold" :size="13" />
        </button>
        <button class="fpw-btn" title="下载" @click.stop="handleDownload">
          <PhDownloadSimple weight="bold" :size="13" />
        </button>
        <button class="fpw-btn" :title="maximized ? '还原' : '最大化'" @click.stop="toggleMaximize">
          <PhCornersOut v-if="!maximized" weight="bold" :size="13" />
          <PhCornersIn  v-else           weight="bold" :size="13" />
        </button>
        <button class="fpw-btn fpw-close" title="关闭" @click.stop="previewStore.closeWindow(win.id)">
          <PhX weight="bold" :size="13" />
        </button>
      </div>
    </div>

    <!-- 内容区 -->
    <div class="fpw-body">
      <!-- 真实内容（在下层） -->
      <ImageViewer v-if="isImg" :blobUrl="blobUrl" @loaded="onImageLoaded" />
      <VideoViewer v-else-if="isVid && videoSrc" :src="videoSrc" />
      <TextViewer  v-else-if="isText && blobUrl" :blobUrl="blobUrl" :ext="win.file.ext" :fontSize="textFontSize" :fileKey="win.file.id ?? win.file.attach_id" />
      <div v-if="loading && !placeholderReady" class="fpw-status">
        <div class="fpw-spinner"></div>
        <span>加载中…</span>
      </div>
      <div v-if="!loading && error" class="fpw-status fpw-error">
        <PhWarningCircle :size="28" style="opacity:.5" />
        <span>{{ error }}</span>
      </div>
      <!-- 占位图覆盖在真实内容上方，imageReady 后淡出，遮住大图解码过程 -->
      <Transition name="ph-fade">
        <div
          v-if="isImg && !imageReady && placeholderSrc"
          class="fpw-placeholder-wrap"
          :class="{ 'fpw-ph-ready': placeholderReady }"
        >
          <img
            class="fpw-placeholder-img"
            :src="placeholderSrc"
            @load="onPlaceholderLoad"
            alt=""
          />
        </div>
      </Transition>
    </div>

    <!-- resize 角标 -->
    <div v-if="!maximized" class="fpw-resize" @mousedown.stop.prevent="startResize"></div>
  </div>

  <!-- 文件信息浮窗（独立弹窗） -->
  <Teleport to="body">
    <Transition name="info-pop">
      <div v-if="showInfo" class="fpw-info-win"
        :style="{ left: infoX+'px', top: infoY+'px', zIndex: win.zIndex + 1 }"
        @mousedown.stop
      >
        <div class="fpw-info-title" @mousedown.prevent="startInfoDrag">
          <span>文件信息</span>
          <button class="fpw-btn fpw-close" @click.stop="showInfo = false">
            <PhX weight="bold" :size="13" />
          </button>
        </div>
        <div class="fpw-info-body">
          <div class="fpw-info-row">
            <span class="fpw-info-label">文件名</span>
            <span class="fpw-info-val">{{ win.file.displayName }}.{{ win.file.ext?.toLowerCase() }}</span>
          </div>
          <div class="fpw-info-row">
            <span class="fpw-info-label">格式</span>
            <span class="fpw-info-val">{{ win.file.ext?.toUpperCase() }}</span>
          </div>
          <div v-if="contentSize" class="fpw-info-row">
            <span class="fpw-info-label">分辨率</span>
            <span class="fpw-info-val">{{ contentSize }}</span>
          </div>
          <div class="fpw-info-row">
            <span class="fpw-info-label">大小</span>
            <span class="fpw-info-val">{{ win.file.size }}</span>
          </div>
          <div class="fpw-info-row">
            <span class="fpw-info-label">创建时间</span>
            <span class="fpw-info-val">{{ win.file.createdAt }}</span>
          </div>
          <div v-if="win.file.projectName" class="fpw-info-row">
            <span class="fpw-info-label">所属项目</span>
            <span class="fpw-info-val">{{ win.file.projectName }}</span>
          </div>
          <div v-if="win.file.folderName" class="fpw-info-row">
            <span class="fpw-info-label">所在文件夹</span>
            <span class="fpw-info-val">{{ win.file.folderName }}</span>
          </div>
          <div v-if="win.file.stageName" class="fpw-info-row">
            <span class="fpw-info-label">阶段</span>
            <span class="fpw-info-val">{{ win.file.stageName }}</span>
          </div>
          <div v-if="win.file.mimeType" class="fpw-info-row">
            <span class="fpw-info-label">MIME</span>
            <span class="fpw-info-val fpw-info-mono">{{ win.file.mimeType }}</span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch, onUnmounted } from 'vue'
import { PhInfo, PhDownloadSimple, PhCornersOut, PhCornersIn, PhX, PhWarningCircle, PhMinus, PhPlus } from '@phosphor-icons/vue'
import ImageViewer from '@/components/common/viewers/ImageViewer.vue'
import VideoViewer from '@/components/common/viewers/VideoViewer.vue'
import TextViewer  from '@/components/common/viewers/TextViewer.vue'
import { filesApi } from '@/services/api'
import { isImageExt, isVideoExt, isTextExt, usePreviewStore } from '@/stores/preview'
import { getCachedThumb, getThumb } from '@/composables/useThumbCache'
import { useLiveStore } from '@/stores/live'
import { registerEsc } from '@/composables/windowz'

const props = defineProps({ win: { type: Object, required: true } })
const previewStore = usePreviewStore()

// ESC 只关最顶层窗口（统一走 windowz：谁 z 最大关谁）
const _unregEsc = registerEsc({
  getZ: () => props.win.zIndex,
  close: () => previewStore.closeWindow(props.win.id),
})

// ── 位置 / 尺寸（本地 reactive，同步回 store） ──────────────────────────────
const x = ref(props.win.x)
const y = ref(props.win.y)
const w = ref(props.win.w)
const h = ref(props.win.h)

// ── 文件类型 ──────────────────────────────────────────────────────────────────
const isImg  = computed(() => isImageExt(props.win.file.ext))
const isVid  = computed(() => isVideoExt(props.win.file.ext))
const isText = computed(() => isTextExt(props.win.file.ext))

const textFontSize = ref(13)

const EXT_COLORS = {
  JPG: '#4caf7d', JPEG: '#4caf7d', PNG: '#4caf7d', WEBP: '#4caf7d',
  GIF: '#9c6fdb', SVG: '#f0a500', BMP: '#8888a8',
  MP4: '#5a8cd8', WEBM: '#5a8cd8', MOV: '#5a8cd8', M4V: '#5a8cd8',
  MD: '#6b9e78', TXT: '#8a8a9a', JSON: '#d4820a', CSV: '#3a8fbf',
  JS: '#f0c000', TS: '#3178c6', PY: '#4b8bbe', CSS: '#a855f7',
  HTML: '#e34c26', YAML: '#cb171e', XML: '#f16529', SH: '#3d9970',
}
const extColor = computed(() => EXT_COLORS[props.win.file.ext?.toUpperCase()] ?? '#7b7fb2')

// ── 内容加载 ─────────────────────────────────────────────────────────────────
const blobUrl         = ref(null)
const videoSrc        = ref(null)
const loading         = ref(false)
const error           = ref(null)
const placeholderReady = ref(false)
const imageReady       = ref(false)

const _SVG_EXTS    = new Set(['SVG'])
const placeholderSrc = ref(null)   // 从 blob Map 取，避免与全图下载竞速

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1'
const TITLE_H  = 40
const PAD      = 48
// 「card」缩略图上限（须与后端 files.py 的 _THUMB_SIZE_MAP["card"] 保持一致）：
// Pillow 的 thumbnail() 只缩小不放大，缩略图长边小于这个值就说明原图从没被缩过，
// 即缩略图尺寸 = 原图真实尺寸，可直接当真实尺寸用，不用再套 4K 估算。
const CARD_THUMB_CAP = 192

const ready        = ref(false)
const maximized    = ref(false)
const animating    = ref(false)
let   savedPos     = null

function toggleMaximize() {
  if (!maximized.value) {
    savedPos = { x: x.value, y: y.value, w: w.value, h: h.value }
    animating.value = true
    maximized.value = true
  } else {
    if (savedPos) { x.value = savedPos.x; y.value = savedPos.y; w.value = savedPos.w; h.value = savedPos.h }
    animating.value = true
    maximized.value = false
  }
  setTimeout(() => { animating.value = false }, 200)
}

const showInfo     = ref(false)
const contentSize  = ref('')
const infoBtnRef   = ref(null)
// 弹窗相对于预览窗口左上角的偏移，随窗口拖拽自动跟随
const infoOffsetX  = ref(0)
const infoOffsetY  = ref(0)
const infoX = computed(() => x.value + infoOffsetX.value)
const infoY = computed(() => y.value + infoOffsetY.value)

function openInfo() {
  if (!showInfo.value && infoBtnRef.value) {
    const r   = infoBtnRef.value.getBoundingClientRect()
    const absX = r.left + r.width / 2 - 110   // 弹窗宽 220，居中对齐按钮
    const absY = r.bottom + 6
    infoOffsetX.value = absX - x.value
    infoOffsetY.value = absY - y.value
  }
  showInfo.value = !showInfo.value
}

let infoDragOrig = null
function startInfoDrag(e) {
  if (e.button !== 0) return
  infoDragOrig = { mx: e.clientX, my: e.clientY, ox: infoOffsetX.value, oy: infoOffsetY.value }
  window.addEventListener('mousemove', onInfoDragMove)
  window.addEventListener('mouseup',   onInfoDragUp)
}
function onInfoDragMove(e) {
  if (!infoDragOrig) return
  infoOffsetX.value = infoDragOrig.ox + e.clientX - infoDragOrig.mx
  infoOffsetY.value = infoDragOrig.oy + e.clientY - infoDragOrig.my
}
function onInfoDragUp() {
  infoDragOrig = null
  window.removeEventListener('mousemove', onInfoDragMove)
  window.removeEventListener('mouseup',   onInfoDragUp)
}

// 按内容自然尺寸适配窗口，居中+错位
function fitWindow(contentW, contentH) {
  const maxW = window.innerWidth  - PAD * 2
  const maxH = window.innerHeight - PAD * 2 - TITLE_H
  let fw = contentW, fh = contentH
  if (fw > maxW || fh > maxH) {
    const scale = Math.min(maxW / fw, maxH / fh)
    fw = Math.round(fw * scale)
    fh = Math.round(fh * scale)
  }
  fw = Math.max(320, fw)
  fh = Math.max(180, fh)
  w.value = fw
  h.value = fh + TITLE_H
  // 居中，按 _idx 错开
  const stagger = (props.win._idx ?? 0) * 30
  x.value = Math.max(0, Math.round((window.innerWidth  - fw) / 2) + stagger)
  y.value = Math.max(0, Math.round((window.innerHeight - fh - TITLE_H) / 2) + stagger)
  ready.value = true
}

function onImageLoaded() {
  // 等两帧确保浏览器已将真实图片合成到屏幕，再淡出占位图
  requestAnimationFrame(() => requestAnimationFrame(() => { imageReady.value = true }))
}

function onPlaceholderLoad(e) {
  if (blobUrl.value) return  // 快速下载：全图已到，不显示占位图
  const { naturalWidth: nw, naturalHeight: nh } = e.target
  // 缩略图长边没到 card 上限 → 没被 Pillow 缩过，就是原图真实尺寸，直接按它定窗口。
  // 顶到上限则原图真实尺寸未知（可能是刚好 192 附近的低分辨率图，也可能是被压缩过的大图，
  // 无法区分）——不再瞎猜（之前套 4K 估算，遇到实际是低分辨率图时会把窗口猜得比真实大得多，
  // 真图加载完再缩回真实尺寸，观感是「先变超大再骤缩」）；宁可窗口暂不出现，等真图加载完
  // 直接定到正确尺寸（同「快速下载」路径），不做中间的错误猜测。
  if (nw && nh && !ready.value && Math.max(nw, nh) < CARD_THUMB_CAP) {
    fitWindow(nw, nh)
  }
  placeholderReady.value = true
}

async function load(f, refresh = false) {
  if (blobUrl.value) { URL.revokeObjectURL(blobUrl.value); blobUrl.value = null }
  videoSrc.value       = null
  loading.value        = true
  error.value          = null
  placeholderReady.value = false
  imageReady.value       = false
  placeholderSrc.value   = null

  // 占位图：优先从 blob Map 同步命中，未缓存则后台 fetch（与全图下载并行）
  if (isImg.value && !_SVG_EXTS.has(f.ext?.toUpperCase())) {
    if (f.attach_id) {
      // 聊天附件：占位图走附件缩略图端点
      const token = localStorage.getItem('user_token') ?? ''
      const h = token ? { Authorization: `Bearer ${token}` } : {}
      fetch(`${BASE_URL}/agent/attachment/${f.attach_id}/thumb?size=card`, { headers: h })
        .then(r => r.ok ? r.blob() : null).then(b => {
          if (b && !imageReady.value) placeholderSrc.value = URL.createObjectURL(b)
        }).catch(() => {})
    } else {
      const cached = getCachedThumb(f.id, 'card')
      if (cached) {
        placeholderSrc.value = cached
      } else {
        getThumb(f.id, 'card').then(url => {
          if (url && !imageReady.value) placeholderSrc.value = url
        })
      }
    }
  }
  // 已知真实尺寸：直接定好窗口，无需等缩略图或下载完成
  if (isImg.value && f.imgWidth && f.imgHeight) {
    if (ready.value) animating.value = true
    fitWindow(f.imgWidth, f.imgHeight)
    if (animating.value) setTimeout(() => { animating.value = false }, 220)
  }
  const token   = localStorage.getItem('user_token') ?? ''
  const headers = token ? { Authorization: `Bearer ${token}` } : {}

  try {
    if (isVideoExt(f.ext)) {
      let url
      if (f.attach_id) {
        const res = await fetch(`${BASE_URL}/agent/attachment/${f.attach_id}/download`, { headers })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        url = URL.createObjectURL(await res.blob())
        videoSrc.value = url
      } else {
        const stream = await filesApi.getStreamUrl(f.id)
        url = stream.url
        videoSrc.value = url
      }
      // 探视频尺寸
      await new Promise(resolve => {
        const vid = document.createElement('video')
        vid.preload = 'metadata'
        vid.onloadedmetadata = () => {
          const vw = vid.videoWidth || 720, vh = vid.videoHeight || 404
          contentSize.value = `${vw} × ${vh}`
          fitWindow(vw, vh)
          vid.src = ''
          resolve()
        }
        vid.onerror = () => { fitWindow(720, 404); resolve() }
        vid.src = url
      })
    } else if (isTextExt(f.ext)) {
      const bust = refresh ? `?_t=${Date.now()}` : ''   // 刷新时绕开浏览器缓存，确保拿到改后的新内容
      const dlUrl = (f.attach_id
        ? `${BASE_URL}/agent/attachment/${f.attach_id}/download`
        : `${BASE_URL}/files/${f.id}/download`) + bust
      const res = await fetch(dlUrl, { headers })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      blobUrl.value = URL.createObjectURL(await res.blob())
      if (!refresh || !ready.value) {
        fitWindow(Math.round(window.innerWidth * 0.44), Math.round(window.innerHeight * 0.86))
      }
    } else {
      const dlUrl = f.attach_id
        ? `${BASE_URL}/agent/attachment/${f.attach_id}/download`
        : `${BASE_URL}/files/${f.id}/download`
      const res = await fetch(dlUrl, { headers })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      blobUrl.value = url
      const img = new Image()
      img.onload = () => {
        contentSize.value = `${img.naturalWidth} × ${img.naturalHeight}`
        const nw = img.naturalWidth, nh = img.naturalHeight
        if (ready.value) {
          // 窗口已显示（有占位图预定尺）：先启用 transition 再改值，保证动画生效
          animating.value = true
          requestAnimationFrame(() => {
            fitWindow(nw, nh)
            setTimeout(() => { animating.value = false }, 220)
          })
        } else {
          // 快速下载（占位图未触发显示）：直接定尺并显示，无需动画
          fitWindow(nw, nh)
        }
      }
      img.src = url
    }
  } catch (e) {
    error.value = '加载失败：' + e.message
    if (!refresh || !ready.value) fitWindow(480, 300)
  } finally {
    loading.value = false
  }
}

watch(() => props.win.file, f => load(f), { immediate: true })

const liveStore = useLiveStore()
watch(() => liveStore.rev.files, () => {
  if (isText.value && !props.win.file.attach_id) load(props.win.file, true)
})

async function handleDownload() {
  try {
    await filesApi.download(props.win.file.id, `${props.win.file.displayName}.${props.win.file.ext.toLowerCase()}`)
  } catch (e) { console.error('[FloatPreview] 下载失败:', e) }
}

// ── 拖拽标题栏移动 ───────────────────────────────────────────────────────────
let dragOrig = null

function startDrag(e) {
  if (e.button !== 0) return
  dragOrig = { mx: e.clientX, my: e.clientY, x: x.value, y: y.value }
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup',   onDragUp)
}

function onDragMove(e) {
  if (!dragOrig) return
  x.value = Math.max(0, dragOrig.x + e.clientX - dragOrig.mx)
  y.value = Math.max(0, dragOrig.y + e.clientY - dragOrig.my)
}

function onDragUp() {
  dragOrig = null
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup',   onDragUp)
}

// ── 右下角 resize ─────────────────────────────────────────────────────────────
let resizeOrig = null
const MIN_W = 320, MIN_H = 240

function startResize(e) {
  if (e.button !== 0) return
  resizeOrig = { mx: e.clientX, my: e.clientY, w: w.value, h: h.value }
  window.addEventListener('mousemove', onResizeMove)
  window.addEventListener('mouseup',   onResizeUp)
}

function onResizeMove(e) {
  if (!resizeOrig) return
  w.value = Math.max(MIN_W, resizeOrig.w + e.clientX - resizeOrig.mx)
  h.value = Math.max(MIN_H, resizeOrig.h + e.clientY - resizeOrig.my)
}

function onResizeUp() {
  resizeOrig = null
  window.removeEventListener('mousemove', onResizeMove)
  window.removeEventListener('mouseup',   onResizeUp)
}

onUnmounted(() => {
  _unregEsc()
  if (blobUrl.value) URL.revokeObjectURL(blobUrl.value)
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup',   onDragUp)
  window.removeEventListener('mousemove', onResizeMove)
  window.removeEventListener('mouseup',   onResizeUp)
  window.removeEventListener('mousemove', onInfoDragMove)
  window.removeEventListener('mouseup',   onInfoDragUp)
})
</script>

<style scoped>
.fpw-root {
  position: fixed;
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  overflow: hidden;
  background: rgba(242, 243, 248, 0.96);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.7);
  box-shadow: 0 12px 48px rgba(20, 25, 60, 0.22), 0 2px 8px rgba(0,0,0,0.08);
  min-width: 320px;
  min-height: 240px;
  user-select: none;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.1s ease;
  will-change: transform;
}
.fpw-root.fpw-ready {
  opacity: 1;
  pointer-events: auto;
}

/* ── 标题栏 ── */
.fpw-title {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 10px 9px 12px;
  background: rgba(255, 255, 255, 0.55);
  border-bottom: 1px solid rgba(0, 0, 0, 0.07);
  cursor: grab;
  flex-shrink: 0;
  min-width: 0;
}
.fpw-title:active { cursor: grabbing; }
.fpw-maximized-bar { cursor: default; }
.fpw-maximized-bar:active { cursor: default; }

.fpw-ext {
  font-size: 8px;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  border-radius: 4px;
  padding: 2px 5px;
  flex-shrink: 0;
}
.fpw-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
  pointer-events: none;
}

.fpw-actions {
  display: flex;
  gap: 0;
  flex-shrink: 0;
  margin-left: 4px;
}
.fpw-btn {
  width: 26px; height: 26px;
  border-radius: 6px; border: none;
  background: none;
  color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.fpw-btn:hover { background: rgba(0,0,0,0.1); color: var(--text-primary); }
.fpw-close:hover { background: rgba(200,90,90,0.12); color: rgba(200,90,90,0.9); }
.fpw-font-size {
  font-size: 10px; font-weight: 600; color: var(--text-secondary);
  min-width: 18px; text-align: center; line-height: 26px; user-select: none;
}

/* ── 内容区 ── */
.fpw-body {
  flex: 1;
  position: relative;
  overflow: hidden;
  background: rgba(220, 222, 232, 0.5);
}
.fpw-body:has(.tv-wrap) {
  background: #fff;
}

/* ── 状态 ── */
.fpw-status {
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 10px; color: var(--text-secondary); font-size: 12px;
}
.fpw-error { color: rgba(180, 80, 80, 0.8); }
.fpw-spinner {
  width: 24px; height: 24px; border-radius: 50%;
  border: 2px solid rgba(123, 127, 178, 0.2);
  border-top-color: rgba(123, 127, 178, 0.7);
  animation: fpw-spin 0.7s linear infinite;
}
@keyframes fpw-spin { to { transform: rotate(360deg); } }

.fpw-placeholder-wrap {
  position: absolute; inset: 0; z-index: 1;
  display: flex; align-items: center; justify-content: center;
  padding: 32px;
  pointer-events: none;
  opacity: 0; transition: opacity 0.15s ease;
}
.fpw-placeholder-wrap.fpw-ph-ready { opacity: 1; }
.ph-fade-leave-active { transition: opacity 0.25s ease !important; }
.ph-fade-leave-to { opacity: 0 !important; }
.fpw-placeholder-img {
  width: 100%; height: 100%;
  object-fit: contain;
  border-radius: 6px;
  display: block;
}

/* ── info 按钮激活态 ── */
.fpw-btn.active { background: rgba(123,127,178,0.15); color: var(--color-primary, #7b7fb2); }

/* ── 信息独立弹窗 ── */
.fpw-info-win {
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
}
.fpw-info-title {
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
.fpw-info-title:active { cursor: grabbing; }
.fpw-info-body {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 70vh;
  overflow-y: auto;
}
.fpw-info-row { display: flex; flex-direction: column; gap: 2px; }
.fpw-info-label {
  font-size: 10px; font-weight: 600;
  color: var(--text-secondary); opacity: .6;
  text-transform: uppercase; letter-spacing: 0.04em;
}
.fpw-info-val {
  font-size: 12px; color: var(--text-primary);
  word-break: break-all; line-height: 1.4;
}
.fpw-info-mono { font-family: monospace; font-size: 11px; }

/* ── 弹窗动画 ── */
.info-pop-enter-active,
.info-pop-leave-active { transition: opacity 0.12s ease, transform 0.12s ease; }
.info-pop-enter-from,
.info-pop-leave-to     { opacity: 0; transform: scale(0.95); }

/* ── resize 角标 ── */
.fpw-resize {
  position: absolute;
  bottom: 0; right: 0;
  width: 16px; height: 16px;
  cursor: se-resize;
  background: linear-gradient(135deg, transparent 50%, rgba(123,127,178,0.25) 50%);
  border-radius: 0 0 12px 0;
}
.fpw-resize:hover {
  background: linear-gradient(135deg, transparent 50%, rgba(123,127,178,0.5) 50%);
}
</style>
