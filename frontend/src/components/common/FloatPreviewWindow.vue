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
          <button class="fpw-btn" title="缩小字号" @click.stop="textFontSize = Math.max(10, textFontSize - 1)"><Icon name="action.subtract" :size="12" /></button>
          <span class="fpw-font-size">{{ textFontSize }}</span>
          <button class="fpw-btn" title="放大字号" @click.stop="textFontSize = Math.min(24, textFontSize + 1)"><Icon name="action.add" :size="12" /></button>
        </template>
        <button ref="infoBtnRef" class="fpw-btn" :class="{ active: showInfo }" title="文件信息" @click.stop="openInfo">
          <Icon name="status.info" :size="13" />
        </button>
        <button class="fpw-btn" title="下载" @click.stop="handleDownload">
          <Icon name="action.download" :size="13" />
        </button>
        <button class="fpw-btn" :title="maximized ? '还原' : '最大化'" @click.stop="toggleMaximize">
          <Icon name="action.expand" v-if="!maximized" :size="13" />
          <Icon name="action.collapse" v-else :size="13" />
        </button>
        <button class="fpw-btn fpw-close" title="关闭" @click.stop="previewStore.closeWindow(win.id)">
          <Icon name="action.close" :size="13" />
        </button>
      </div>
    </div>

    <!-- 内容区 -->
    <div class="fpw-body">
      <!-- 真实内容（在下层） -->
      <ImageViewer v-if="isImg" ref="imageViewerRef" :blobUrl="blobUrl ?? undefined" @loaded="onImageLoaded" />
      <VideoViewer v-else-if="isVid && videoSrc" :src="videoSrc ?? undefined" />
      <TextViewer  v-else-if="isText && blobUrl" :blobUrl="blobUrl ?? undefined" :ext="win.file.ext" :fontSize="textFontSize" :fileKey="win.file.id ?? win.file.attach_id ?? undefined" :fileContext="win.file" />
      <div v-if="loading && !placeholderReady" class="fpw-status">
        <div class="fpw-spinner"></div>
        <span>加载中…</span>
      </div>
      <div v-if="!loading && error" class="fpw-status fpw-error">
        <Icon name="status.warning" :size="28" style="opacity:.5" />
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
            :src="placeholderSrc ?? undefined"
            :style="placeholderTransformStyle"
            @load="onPlaceholderLoad"
            alt=""
          />
        </div>
      </Transition>
      <!-- 同目录图片左右切换 -->
      <template v-if="canNav">
        <button class="fpw-nav fpw-nav-prev" title="上一张" @click.stop="goPrev">
          <Icon name="action.back" :size="18" />
        </button>
        <button class="fpw-nav fpw-nav-next" title="下一张" @click.stop="goNext">
          <Icon name="action.next" :size="18" />
        </button>
      </template>
    </div>

    <!-- resize：右下角带图标手柄，其余三角只留可拖拽热区（无图标） -->
    <template v-if="!maximized">
      <div class="fpw-resize" @mousedown.stop.prevent="startResize('se', $event)"></div>
      <div class="fpw-resize-edge fpw-resize-n" @mousedown.stop.prevent="startResize('n', $event)"></div>
      <div class="fpw-resize-edge fpw-resize-e" @mousedown.stop.prevent="startResize('e', $event)"></div>
      <div class="fpw-resize-edge fpw-resize-s" @mousedown.stop.prevent="startResize('s', $event)"></div>
      <div class="fpw-resize-edge fpw-resize-w" @mousedown.stop.prevent="startResize('w', $event)"></div>
      <div class="fpw-resize-edge fpw-resize-nw" @mousedown.stop.prevent="startResize('nw', $event)"></div>
      <div class="fpw-resize-edge fpw-resize-ne" @mousedown.stop.prevent="startResize('ne', $event)"></div>
      <div class="fpw-resize-edge fpw-resize-sw" @mousedown.stop.prevent="startResize('sw', $event)"></div>
    </template>
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
            <Icon name="action.close" :size="13" />
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

<script setup lang="ts">
import { ref, computed, watch, onUnmounted , type PropType} from 'vue'
import Icon from '@/components/common/Icon.vue'
import type { PreviewWindow } from '@/stores/preview'
import type { FileMeta } from '@/stores/filesCache'
import ImageViewer from '@/components/common/viewers/ImageViewer.vue'
import VideoViewer from '@/components/common/viewers/VideoViewer.vue'
import TextViewer  from '@/components/common/viewers/TextViewer.vue'
import { CLIENT_ID, filesApi } from '@/services/api'
import { isImageExt, isVideoExt, isTextExt, usePreviewStore } from '@/stores/preview'
import { getCachedThumb, getThumb } from '@/composables/useThumbCache'
import { useLiveStore } from '@/stores/live'
import { registerEsc, registerArrowNav } from '@/composables/windowz'

// 类型见下
const props = defineProps({ win: { type: Object as PropType<PreviewWindow>, required: true } })
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

// ── 图片左右切换（同目录，来自打开时传入的 win.siblings） ─────────────────────
const navImages = computed(() => (props.win.siblings || []).filter(f => isImageExt(f.ext)))
const canNav    = computed(() => isImg.value && navImages.value.length > 1)
function goPrev() { previewStore.navigate(props.win.id, -1) }
function goNext() { previewStore.navigate(props.win.id, 1) }

// 方向键只切最顶层窗口（同 ESC：多个预览窗同时开着，谁 z 最大谁响应）
const _unregArrowNav = registerArrowNav({
  getZ: () => props.win.zIndex,
  prev: () => { if (canNav.value) goPrev() },
  next: () => { if (canNav.value) goNext() },
})

const textFontSize = ref(13)

const EXT_COLORS: Record<string, string> = {
  JPG: '#4caf7d', JPEG: '#4caf7d', PNG: '#4caf7d', WEBP: '#4caf7d',
  GIF: '#9c6fdb', SVG: '#f0a500', BMP: '#8888a8',
  MP4: '#5a8cd8', WEBM: '#5a8cd8', MOV: '#5a8cd8', M4V: '#5a8cd8',
  MD: '#6b9e78', TXT: '#8a8a9a', JSON: '#d4820a', CSV: '#3a8fbf',
  JS: '#f0c000', TS: '#3178c6', PY: '#4b8bbe', CSS: '#a855f7',
  HTML: '#e34c26', YAML: '#cb171e', XML: '#f16529', SH: '#3d9970',
}
const extColor = computed(() => EXT_COLORS[(props.win.file.ext ?? '').toUpperCase()] ?? '#7b7fb2')

// ── 内容加载 ─────────────────────────────────────────────────────────────────
const blobUrl         = ref<string | null>(null)
const videoSrc        = ref<string | null>(null)
const loading         = ref(false)
const error           = ref<string | null>(null)
const placeholderReady = ref(false)
const imageReady       = ref(false)

const _SVG_EXTS    = new Set(['SVG'])
const placeholderSrc = ref<string | null>(null)   // 从 blob Map 取，避免与全图下载竞速

// 占位缩略图套上跟 ImageViewer 当前一致的缩放/平移，切图时才不会先跳回居中/100%
// 再跳回真图当前的视图——两次跳变叠在一起就是用户看到的"闪一下"。
const imageViewerRef = ref<InstanceType<typeof ImageViewer> | null>(null)
const placeholderTransformStyle = computed(() => {
  const iv = imageViewerRef.value
  if (!iv) return {}
  return { transform: `translate(${iv.tx}px, ${iv.ty}px) scale(${iv.scale})` }
})

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
let   savedPos: { x: number; y: number; w: number; h: number } | null = null

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
const infoBtnRef   = ref<HTMLElement | null>(null)
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

let infoDragOrig: { mx: number; my: number; ox: number; oy: number } | null = null
function startInfoDrag(e: MouseEvent) {
  if (e.button !== 0) return
  infoDragOrig = { mx: e.clientX, my: e.clientY, ox: infoOffsetX.value, oy: infoOffsetY.value }
  window.addEventListener('mousemove', onInfoDragMove)
  window.addEventListener('mouseup',   onInfoDragUp)
}
function onInfoDragMove(e: MouseEvent) {
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
function fitWindow(contentW: number, contentH: number) {
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

function onPlaceholderLoad(e: Event) {
  if (blobUrl.value) return  // 快速下载：全图已到，不显示占位图
  const { naturalWidth: nw, naturalHeight: nh } = e.target as HTMLImageElement
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

async function load(f: Partial<FileMeta>, refresh = false) {
  if (blobUrl.value) { URL.revokeObjectURL(blobUrl.value); blobUrl.value = null }
  videoSrc.value       = null
  loading.value        = true
  error.value          = null
  placeholderReady.value = false
  imageReady.value       = false
  placeholderSrc.value   = null

  // 占位图：优先从 blob Map 同步命中，未缓存则后台 fetch（与全图下载并行）
  if (isImg.value && !_SVG_EXTS.has((f.ext ?? '').toUpperCase())) {
    if (f.attach_id) {
      // 聊天附件：占位图走附件缩略图端点
      const token = localStorage.getItem('user_token') ?? ''
      const h: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
      fetch(`${BASE_URL}/agent/attachment/${f.attach_id}/thumb?size=card`, { headers: h })
        .then(r => r.ok ? r.blob() : null).then(b => {
          if (b && !imageReady.value) placeholderSrc.value = URL.createObjectURL(b)
        }).catch(() => {})
    } else {
      const cached = getCachedThumb(f.id!, 'card')
      if (cached) {
        placeholderSrc.value = cached
      } else {
        getThumb(f.id!, 'card').then((url: string | null | undefined) => {
          if (url && !imageReady.value) placeholderSrc.value = url
        })
      }
    }
  }
  // 已知真实尺寸：直接定好窗口，无需等缩略图或下载完成。窗口尺寸只由打开时的第一张图
  // 决定，跟内容解耦——切换到其它图片不再重新定窗口尺寸，图片靠 object-fit:contain
  // 在固定窗口里自适应显示，不然窗口宽高跟着每张图变化，观感很跳。
  if (isImg.value && f.imgWidth && f.imgHeight && !ready.value) {
    fitWindow(f.imgWidth, f.imgHeight)
  }
  const token   = localStorage.getItem('user_token') ?? ''
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}

  try {
    if (isVideoExt(f.ext)) {
      let url
      if (f.attach_id) {
        const res = await fetch(`${BASE_URL}/agent/attachment/${f.attach_id}/download`, { headers })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        url = URL.createObjectURL(await res.blob())
        videoSrc.value = url
      } else {
        const stream = await filesApi.getStreamUrl(f.id!)
        url = stream.url
        videoSrc.value = url
      }
      // 探视频尺寸
      await new Promise<void>(resolve => {
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
        // 窗口尺寸只由打开时的第一张图决定（同上），这里只在窗口还没显示过时才定尺。
        if (!ready.value) fitWindow(img.naturalWidth, img.naturalHeight)
      }
      img.src = url
    }
  } catch (e) {
    error.value = '加载失败：' + (e instanceof Error ? e.message : e)
    if (!refresh || !ready.value) fitWindow(480, 300)
  } finally {
    loading.value = false
  }
}

watch(() => props.win.file, f => load(f), { immediate: true })

const liveStore = useLiveStore()
watch(() => liveStore.resourceEvent, (event) => {
  if (event?.resource !== 'files') return
  if (event?.origin === CLIENT_ID) return
  if (isText.value && !props.win.file.attach_id) load(props.win.file, true)
})

async function handleDownload() {
  try {
    const file = props.win.file
    const filename = `${file.displayName}.${file.ext?.toLowerCase()}`
    if (file.attach_id) {
      const token = localStorage.getItem('user_token') ?? ''
      const res = await fetch(`${BASE_URL}/agent/attachment/${file.attach_id}/download`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const url = URL.createObjectURL(await res.blob())
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } else if (file.id != null) {
      await filesApi.download(file.id, filename)
    }
  } catch (e) { console.error('[FloatPreview] 下载失败:', e) }
}

// ── 拖拽标题栏移动 ───────────────────────────────────────────────────────────
let dragOrig: { mx: number; my: number; x: number; y: number } | null = null
const DRAG_OVERSCAN_RATIO = .25

function previewDragBounds() {
  const overscanX = window.innerWidth * DRAG_OVERSCAN_RATIO
  const overscanY = window.innerHeight * DRAG_OVERSCAN_RATIO
  const minX = -overscanX
  const minY = -overscanY
  return {
    minX,
    maxX: Math.max(minX, window.innerWidth + overscanX - w.value),
    minY,
    maxY: Math.max(minY, window.innerHeight + overscanY - h.value),
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function startDrag(e: MouseEvent) {
  if (e.button !== 0) return
  dragOrig = { mx: e.clientX, my: e.clientY, x: x.value, y: y.value }
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup',   onDragUp)
}

function onDragMove(e: MouseEvent) {
  if (!dragOrig) return
  const nextX = dragOrig.x + e.clientX - dragOrig.mx
  const nextY = dragOrig.y + e.clientY - dragOrig.my
  const { minX, maxX, minY, maxY } = previewDragBounds()
  x.value = clamp(nextX, minX, maxX)
  y.value = clamp(nextY, minY, maxY)
}

function onDragUp() {
  dragOrig = null
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup',   onDragUp)
}

// ── 四角 resize（可见手柄只留右下角，其余三角只是能拖、没有图标）────────────────
let resizeOrig: { mx: number; my: number; w: number; h: number; x: number; y: number; dir: string } | null = null
const MIN_W = 320, MIN_H = 240

function startResize(dir: string, e: MouseEvent) {
  if (e.button !== 0) return
  resizeOrig = { mx: e.clientX, my: e.clientY, w: w.value, h: h.value, x: x.value, y: y.value, dir }
  window.addEventListener('mousemove', onResizeMove)
  window.addEventListener('mouseup',   onResizeUp)
}

function onResizeMove(e: MouseEvent) {
  if (!resizeOrig) return
  const { mx, my, w: ow, h: oh, x: ox, y: oy, dir } = resizeOrig
  const dx = e.clientX - mx
  const dy = e.clientY - my
  // 左侧的角：一边收缩宽度一边把 x 往右挪，钳到 MIN_W 后用实际收缩量算 x，避免碰到下限后窗口和鼠标脱节
  // 单边手柄（n/s/e/w）只含一个方向字母，只能动对应那根轴；四角手柄（se/sw/ne/nw）两根轴都动，不受影响。
  if (dir.includes('e') || dir.includes('w')) {
    if (dir.includes('e')) {
      w.value = Math.max(MIN_W, ow + dx)
    } else {
      const newW = Math.max(MIN_W, ow - dx)
      x.value = Math.max(0, ox + (ow - newW))
      w.value = newW
    }
  }
  if (dir.includes('s') || dir.includes('n')) {
    if (dir.includes('s')) {
      h.value = Math.max(MIN_H, oh + dy)
    } else {
      const newH = Math.max(MIN_H, oh - dy)
      y.value = Math.max(0, oy + (oh - newH))
      h.value = newH
    }
  }
}

function onResizeUp() {
  resizeOrig = null
  window.removeEventListener('mousemove', onResizeMove)
  window.removeEventListener('mouseup',   onResizeUp)
}

onUnmounted(() => {
  _unregEsc()
  _unregArrowNav()
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
  overflow: visible;
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
  border-radius: 12px 12px 0 0;
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
  border-radius: 0 0 12px 12px;
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

/* ── 图片左右切换按钮：平时隐藏，鼠标移进内容区才淡入；跟 ImageViewer 缩放胶囊
   （.iv-toolbar）同一套毛玻璃参数，视觉上是一家人 ── */
.fpw-nav {
  position: absolute; top: 50%; z-index: 2;
  width: 34px; height: 34px;
  margin-top: -17px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.68);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  border: 1px solid rgba(255, 255, 255, 0.82);
  box-shadow:
    0 4px 16px rgba(80, 90, 110, 0.10),
    inset 0 1px 0 rgba(255, 255, 255, 0.95),
    inset 1px 0 0 rgba(255, 255, 255, 0.55);
  color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;   /* 隐藏时别挡住底下图片的点击/拖拽 */
  transition: opacity 0.15s, background 0.15s, color 0.15s, box-shadow 0.15s;
}
.fpw-body:hover .fpw-nav { opacity: 1; pointer-events: auto; }
.fpw-nav:hover {
  box-shadow:
    0 2px 14px rgba(80, 90, 110, 0.16),
    inset 0 1px 0 rgba(255, 255, 255, 0.95),
    inset 1px 0 0 rgba(255, 255, 255, 0.55);
}
.fpw-nav-prev { left: 10px; }
.fpw-nav-next { right: 10px; }

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
.fpw-info-mono { font-family: var(--font-family-mono); font-size: 11px; }

/* ── 弹窗动画 ── */
.info-pop-enter-active,
.info-pop-leave-active { transition: opacity 0.12s ease, transform 0.12s ease; }
.info-pop-enter-from,
.info-pop-leave-to     { opacity: 0; transform: scale(0.95); }

/* ── resize 边缘与角标 ── */
.fpw-resize {
  position: absolute;
  bottom: -7.5px; right: -7.5px;
  width: 15px; height: 15px;
  cursor: se-resize;
}
/* 只保留透明的可拖拽热区，缩放提示由鼠标指针提供。 */
.fpw-resize-edge { position: absolute; width: 15px; height: 15px; }
.fpw-resize-n, .fpw-resize-s { left: 15px; right: 15px; width: auto; height: 15px; cursor: ns-resize; }
.fpw-resize-n { top: -7.5px; }
.fpw-resize-s { bottom: -7.5px; }
.fpw-resize-e, .fpw-resize-w { top: 15px; bottom: 15px; width: 15px; height: auto; cursor: ew-resize; }
.fpw-resize-e { right: -15px; }
.fpw-resize-w { left: -7.5px; }
.fpw-resize-nw { top: -7.5px; left: -7.5px; cursor: nwse-resize; }
.fpw-resize-ne { top: -7.5px; right: -7.5px; cursor: nesw-resize; }
.fpw-resize-sw { bottom: -7.5px; left: -7.5px; cursor: nesw-resize; }
</style>
