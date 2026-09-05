<template>
  <Teleport to="body">
    <!-- 时长必须覆盖面板本身的滑动动画（入场 420ms、退场 260ms），否则 Vue 会提前卸载抽屉。 -->
    <Transition name="fp" :duration="{ enter: 420, leave: 260 }">
      <div v-if="show && !!file" class="fp-root" :style="{ zIndex: myZ }" @mousedown.capture="raise">
        <div class="fp-overlay" @click="$emit('close')" />
        <div class="fp-panel">
          <!-- 顶栏 -->
          <div class="fp-header">
            <div class="fp-title">
              <span class="fp-ext" :style="{ color: extColor, background: extColor + '1a' }">{{ file.ext }}</span>
              <span class="fp-name" :title="file.displayName">{{ file.displayName }}</span>
            </div>
            <div class="fp-header-actions">
              <button ref="infoBtnRef" class="fp-action-btn" :class="{ active: showInfo }" :title="t('files.info')" @click="openInfo">
                <Icon name="status.info" :size="16" />
              </button>
              <button class="fp-action-btn" :title="t('common.actions.download')" @click="handleDownload">
                <Icon name="action.download" :size="16" />
              </button>
              <button class="fp-action-btn fp-close-btn" :title="`${t('common.actions.close')} (Esc)`" @click="$emit('close')">
                <Icon name="action.close" :size="16" />
              </button>
            </div>
          </div>

          <!-- 内容区 -->
          <div class="fp-body">
            <div v-if="loading" class="fp-status">
              <div class="fp-spinner"></div>
              <span>{{ converting ? t('files.converting') : t('files.loading') }}</span>
            </div>
            <div v-else-if="error" class="fp-status fp-error">
              <Icon name="status.warning" :size="32" style="opacity:.5" />
              <span>{{ error }}</span>
            </div>
            <template v-else-if="blobUrl || videoSrc">
              <PdfViewer   v-if="isPdf || isOffice" :blobUrl="blobUrl ?? undefined" />
              <ImageViewer v-else-if="isImage"      :blobUrl="blobUrl ?? undefined" />
              <TextViewer  v-else-if="isText"       :blobUrl="blobUrl ?? undefined" :ext="file?.ext" :fileKey="file?.id ?? file?.attach_id ?? undefined" :fileContext="file ?? null" />
              <VideoViewer v-else-if="isVideo"      :src="videoSrc ?? undefined" />

            </template>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 文件信息弹窗 -->
    <Transition name="info-pop">
      <div v-if="showInfo && file" class="fp-info-win"
        :style="{ left: infoX+'px', top: infoY+'px', zIndex: myZ + 1 }"
        @mousedown.stop
      >
        <div class="fp-info-title" @mousedown.prevent="startInfoDrag">
          <span>{{ t('files.info') }}</span>
          <button class="fp-action-btn fp-close-btn" @click="showInfo = false">
            <Icon name="action.close" :size="15" />
          </button>
        </div>
        <div class="fp-info-body">
          <div class="fp-info-row">
            <span class="fp-info-label">{{ t('files.name') }}</span>
            <span class="fp-info-val">{{ file.displayName }}.{{ file.ext?.toLowerCase() }}</span>
          </div>
          <div class="fp-info-row">
            <span class="fp-info-label">{{ t('files.format') }}</span>
            <span class="fp-info-val">{{ file.ext?.toUpperCase() }}</span>
          </div>
          <div class="fp-info-row">
            <span class="fp-info-label">{{ t('files.size') }}</span>
            <span class="fp-info-val">{{ file.size }}</span>
          </div>
          <div class="fp-info-row">
            <span class="fp-info-label">{{ t('files.createdAt') }}</span>
            <span class="fp-info-val">{{ file.createdAt }}</span>
          </div>
          <div v-if="file.projectName" class="fp-info-row">
            <span class="fp-info-label">{{ t('files.project') }}</span>
            <span class="fp-info-val">{{ file.projectName }}</span>
          </div>
          <div v-if="file.folderName" class="fp-info-row">
            <span class="fp-info-label">{{ t('files.folderLocation') }}</span>
            <span class="fp-info-val">{{ file.folderName }}</span>
          </div>
          <div v-if="file.stageName" class="fp-info-row">
            <span class="fp-info-label">{{ t('files.stage') }}</span>
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

<script setup lang="ts">
import { ref, watch, computed, onUnmounted, nextTick, type PropType } from 'vue'
import type { FileMeta } from '@/stores/filesCache'
import Icon from '@/components/common/icons/Icon.vue'
import ImageViewer from '@/components/common/viewers/ImageViewer.vue'
import TextViewer  from '@/components/common/viewers/TextViewer.vue'
import { useLiveStore } from '@/stores/live'
import VideoViewer from '@/components/common/viewers/VideoViewer.vue'
import PdfViewer   from '@/components/common/viewers/PdfViewer.vue'

import { CLIENT_ID, filesApi } from '@/services/api'
import { isImageExt, isTextExt, isVideoExt, isOfficeExt, isAudioExt } from '@/stores/preview'
import { nextZ, registerEsc } from '@/composables/core/windowz'
import { usePreviewBlobCache } from '@/composables/shared/usePreviewBlobCache'
import { useI18n } from 'vue-i18n'

const props = defineProps({
  show: Boolean,
  file: { type: Object as PropType<Partial<FileMeta>>, default: undefined },
})
const { t } = useI18n()
const emit = defineEmits(['close'])

const blobUrl    = ref<string | null>(null)
const videoSrc   = ref<string | null>(null)
const loading    = ref(false)
const converting = ref(false)
const error      = ref<string | null>(null)
const previewBlobCache = usePreviewBlobCache()
const currentCacheKey = ref('')

const isImage  = computed(() => isImageExt(props.file?.ext))
const isText   = computed(() => isTextExt(props.file?.ext))
const isVideo  = computed(() => isVideoExt(props.file?.ext))
const isPdf    = computed(() => props.file?.ext?.toUpperCase() === 'PDF')
const isOffice = computed(() => isOfficeExt(props.file?.ext))
const isAudio  = computed(() => isAudioExt(props.file?.ext))

const EXT_COLORS: Record<string, string> = {
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
  previewBlobCache.release(currentCacheKey.value, blobUrl.value)
  blobUrl.value = null
  videoSrc.value = null
  currentCacheKey.value = ''
}

async function load(file: Partial<FileMeta>, refresh = false) {
  revoke()
  currentCacheKey.value = ''   // 先按旧 key 判定上一个 blob 是否在缓存里，再清掉防串位
  loading.value    = true
  converting.value = false
  error.value      = null
  extColor.value   = EXT_COLORS[(file.ext ?? '').toUpperCase()] ?? '#7b7fb2'

  const BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1'
  const token    = localStorage.getItem('user_token') ?? ''
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}

  try {
    if (isVideoExt(file.ext)) {
      const { url } = await filesApi.getStreamUrl(file.id!)
      videoSrc.value = url
    } else if (isOfficeExt(file.ext)) {
      converting.value = true
      const officeUrl = file.attach_id
        ? `${BASE_URL}/agent/attachment/${file.attach_id}/preview-pdf`
        : `${BASE_URL}/files/${file.id!}/preview-pdf`
      const res = await fetch(officeUrl, { headers })
      converting.value = false
      if (!res.ok) throw new Error(`转换失败 (${res.status})`)
      let blob = await res.blob()
      // iframe 内嵌渲染要求 application/pdf，转换结果若非此类型则重包一层
      if (blob.type !== 'application/pdf') blob = new Blob([blob], { type: 'application/pdf' })
      blobUrl.value = URL.createObjectURL(blob)
    } else {
      const bust = refresh ? `?_t=${Date.now()}` : ''   // 刷新时绕开浏览器缓存，确保拿到改后的新内容
      const key = previewBlobCache.keyOf(file)
      currentCacheKey.value = bust ? '' : key
      if (!bust) {
        const cached = previewBlobCache.get(key)
        if (cached) { blobUrl.value = cached; return }
      }
      const dlUrl = (file.attach_id
        ? `${BASE_URL}/agent/attachment/${file.attach_id}/download`
        : `${BASE_URL}/files/${file.id!}/download`) + bust
      const res = await fetch(dlUrl, { headers })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      let blob = await res.blob()
      // PDF 走 iframe 原生渲染，blob 必须是 application/pdf，否则浏览器可能当下载/空白
      if (file.ext?.toUpperCase() === 'PDF' && blob.type !== 'application/pdf') {
        blob = new Blob([blob], { type: 'application/pdf' })
      }
      const url = URL.createObjectURL(blob)
      blobUrl.value = url
      // 强制刷新也要替换同一 key 的旧 blob，避免关闭后再次打开回到旧内容。
      previewBlobCache.put(key, url)
      currentCacheKey.value = key
    }
  } catch (e) {
    error.value = t('files.loadFailed', { message: e instanceof Error ? e.message : String(e) })
  } finally {
    loading.value    = false
    converting.value = false
  }
}

watch(() => [props.show, props.file] as [boolean, Partial<FileMeta> | undefined], ([show, file]) => {
  if (show && file) load(file)
  else revoke()
}, { immediate: true })

const liveStore = useLiveStore()
watch(() => liveStore.resourceEvent, (event) => {
  if (event?.resource !== 'files') return
  if (event?.origin === CLIENT_ID) return
  if (props.show && props.file && isText.value) load(props.file, true)
})

// 窗口层级:打开领新 z、点击置顶;ESC 统一走 windowz(只关最顶层)
const myZ = ref(0)
function raise() { myZ.value = nextZ() }
let _unregEsc: (() => void) | null = null
watch(() => props.show, v => {
  if (v) {
    raise()
    _unregEsc = registerEsc({ getZ: () => myZ.value, close: () => emit('close') })
  } else {
    _unregEsc?.(); _unregEsc = null
  }
}, { immediate: true })

async function handleDownload() {
  if (!props.file) return
  try {
    const file = props.file
    const filename = `${file.displayName}.${file.ext?.toLowerCase()}`
    if (file.attach_id) {
      const BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1'
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
  } catch (e) {
    console.error('[Preview] 下载失败:', e)
  }
}

onUnmounted(() => {
  revoke()
  _unregEsc?.()
  window.removeEventListener('mousemove', onInfoDragMove)
  window.removeEventListener('mouseup',   onInfoDragUp)
})

// ── 文件信息弹窗 ─────────────────────────────────────────────────────────────
const showInfo   = ref(false)
const infoX      = ref(0)
const infoY      = ref(0)
const infoBtnRef = ref<HTMLElement | null>(null)

async function openInfo() {
  if (!showInfo.value && infoBtnRef.value) {
    await nextTick()
    const r = infoBtnRef.value.getBoundingClientRect()
    infoX.value = Math.max(8, r.right - 220)
    infoY.value = r.bottom + 6
  }
  showInfo.value = !showInfo.value
}

let infoDragOrig: { mx: number; my: number; x: number; y: number } | null = null
function startInfoDrag(e: MouseEvent) {
  if (e.button !== 0) return
  infoDragOrig = { mx: e.clientX, my: e.clientY, x: infoX.value, y: infoY.value }
  window.addEventListener('mousemove', onInfoDragMove)
  window.addEventListener('mouseup',   onInfoDragUp)
}
function onInfoDragMove(e: MouseEvent) {
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
  /* z-index 由 :style 动态(统一窗口带,点谁谁上) */
  overflow: hidden;
  /* 整个预览模态提升为独立 GPU 合成层，防止 OOPIF（PDF iframe）的创建/销毁
     触发外层 sidebar/topbar backdrop-filter 的重合成闪烁 */
  will-change: transform;
}

/* ── 遮罩 ── */
.fp-overlay {
  position: absolute;
  inset: 0;
  background: var(--surface-scrim);
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
  background: var(--modal-card-bg);
  border-left: 1px solid var(--modal-card-border);
  border-radius: 20px 0 0 20px;
  box-shadow: var(--modal-card-shadow), inset 1px 0 0 var(--modal-card-highlight);
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
  border-bottom: 1px solid var(--panel-divider);
  background: var(--surface-glass);
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
.fp-action-btn:hover { background: var(--surface-soft-hover); color: var(--content-primary); }
.fp-close-btn:hover { background: var(--status-danger-bg); color: var(--status-danger); }

/* ── 内容区 ── */
.fp-body {
  flex: 1;
  overflow: hidden;
  position: relative;
  background: var(--surface-base);
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
.fp-error { color: var(--status-danger); }
.fp-spinner {
  width: 28px; height: 28px; border-radius: 50%;
  border: 2px solid var(--action-soft);
  border-top-color: var(--action-primary);
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

/* 入场：从右侧滑入，先快后慢，带轻微弹性感 */
.fp-enter-active .fp-panel {
  transition: transform 0.42s cubic-bezier(0.16, 1, 0.3, 1);
}
/* 退场：向右侧滑出，先慢后快，加速收回 */
.fp-leave-active .fp-panel {
  transition: transform 0.26s cubic-bezier(0.4, 0, 0.8, 0.6);
}
.fp-enter-from .fp-panel,
.fp-leave-to   .fp-panel { transform: translateX(100%); }

/* ── info 按钮激活态 ── */
.fp-action-btn.active { background: var(--action-soft); color: var(--action-primary); }

/* ── 文件信息弹窗 ── */
.fp-info-win {
  position: fixed;
  width: 220px;
  border-radius: 12px;
  overflow: hidden;
  background: var(--popup-surface-bg);
  backdrop-filter: var(--popup-surface-blur);
  -webkit-backdrop-filter: var(--popup-surface-blur);
  border: 1px solid var(--popup-surface-border);
  box-shadow: var(--popup-surface-shadow);
  user-select: none;
  /* z-index 由 :style 动态(myZ+1,信息窗在面板之上) */
}
.fp-info-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 10px 9px 14px;
  background: var(--surface-glass);
  border-bottom: 1px solid var(--panel-divider);
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
.fp-info-mono { font-family: var(--font-family-mono); font-size: 11px; }
.info-pop-enter-active,
.info-pop-leave-active { transition: opacity 0.12s ease, transform 0.12s ease; }
.info-pop-enter-from,
.info-pop-leave-to     { opacity: 0; transform: scale(0.95); }
</style>
