<template>
  <div
    class="vv-wrap"
    @mousemove="showBtn"
    @mouseleave="onMouseLeave"
  >
    <video
      ref="videoRef"
      class="vv-video"
      :src="activeSrc"
      :controls="visible"
      playsinline
      preload="metadata"
      @volumechange="persistVolume"
      @error="onError"
      @play="onPlay"
      @pause="playing = false"
      @ended="playing = false"
    ></video>

    <Transition name="vv-btn">
      <div
        v-if="visible && !error"
        class="vv-center-wrap"
      >
        <button class="vv-center-btn" @click="togglePlay">
          <Icon name="media.play"  v-if="!playing" :size="32" />
          <Icon name="media.pause" v-else :size="32" />
        </button>
      </div>
    </Transition>

    <div v-if="error" class="vv-status vv-error">
      <Icon name="status.warning" :size="32" style="opacity:.5" />
      <span>{{ t('viewerUi.videoUnsupported') }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch, type PropType } from 'vue'
import Icon from '@/components/common/icons/Icon.vue'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
const props = defineProps({
  src: { type: String, default: null },
  refreshSrc: { type: Function as PropType<() => Promise<string>>, default: undefined },
})

const videoRef = ref<HTMLVideoElement | null>(null)
const activeSrc = ref(props.src)
const error    = ref(false)
const playing  = ref(false)
const visible  = ref(false)
const VIDEO_VOLUME_KEY = 'gugu_video_volume'

let hideTimer: ReturnType<typeof setTimeout> | null = null
const VIDEO_SOURCE_REFRESH_AFTER_MS = 8 * 60 * 1000
let sourceCreatedAt = Date.now()
let sourceRefreshAttempted = false
let sourceRefreshPromise: Promise<boolean> | null = null
let sourceGeneration = 0
let cancelMetadataWait: (() => void) | null = null
let mounted = true

function readSavedVolume(): number | null {
  try {
    const stored = localStorage.getItem(VIDEO_VOLUME_KEY)
    if (stored === null) return null
    const volume = Number(stored)
    return Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : null
  } catch {
    return null
  }
}

function restoreVolume() {
  const volume = readSavedVolume()
  if (volume !== null && videoRef.value) videoRef.value.volume = volume
}

function persistVolume(event: Event) {
  const video = event.currentTarget as HTMLVideoElement
  try {
    localStorage.setItem(VIDEO_VOLUME_KEY, String(video.volume))
  } catch {
    // 存储不可用时仍可正常调整当前播放器音量。
  }
}

onMounted(restoreVolume)

// ── 显示 / 隐藏 ───────────────────────────────────────
function showBtn() {
  visible.value = true
  clearTimeout(hideTimer ?? undefined)
  hideTimer = setTimeout(() => { visible.value = false }, 1000)
}

function onMouseLeave() {
  clearTimeout(hideTimer ?? undefined)
  visible.value = false
}

// ── 视频控制 ──────────────────────────────────────────
watch(() => props.src, (src) => {
  sourceGeneration += 1
  activeSrc.value = src
  sourceCreatedAt = Date.now()
  sourceRefreshAttempted = false
  error.value   = false
  playing.value = false
  if (videoRef.value) {
    restoreVolume()
    videoRef.value.load()
  }
})

function sourceNeedsRefresh() {
  return Date.now() - sourceCreatedAt >= VIDEO_SOURCE_REFRESH_AFTER_MS
}

function isAbortError(reason: unknown) {
  return reason instanceof DOMException && reason.name === 'AbortError'
}

function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const cleanup = () => {
      clearTimeout(timer)
      video.removeEventListener('loadedmetadata', onLoaded)
      video.removeEventListener('error', onFailed)
      cancelMetadataWait = null
    }
    const finish = (reason?: unknown) => {
      cleanup()
      if (reason) reject(reason)
      else resolve()
    }
    const onLoaded = () => finish()
    const onFailed = () => finish(new Error('视频源刷新后仍无法读取媒体信息'))
    cancelMetadataWait = () => finish(new DOMException('播放器已关闭', 'AbortError'))
    timer = setTimeout(() => finish(new Error('等待视频源刷新超时')), 15_000)
    video.addEventListener('loadedmetadata', onLoaded, { once: true })
    video.addEventListener('error', onFailed, { once: true })
    video.load()
  })
}

async function refreshSource(resumePlayback: boolean): Promise<boolean> {
  if (!props.refreshSrc || sourceRefreshAttempted) return false
  if (sourceRefreshPromise) return sourceRefreshPromise

  const video = videoRef.value
  if (!video) return false
  const generation = sourceGeneration
  sourceRefreshAttempted = true
  const position = video.currentTime
  sourceRefreshPromise = (async () => {
    try {
      video.pause()
      const newSrc = await props.refreshSrc?.()
      if (!mounted || generation !== sourceGeneration || !newSrc) return false
      activeSrc.value = newSrc
      sourceCreatedAt = Date.now()
      error.value = false
      await nextTick()
      if (!mounted || generation !== sourceGeneration || !videoRef.value) return false
      await waitForMetadata(videoRef.value)
      // 等待媒体元数据期间可能已切换到另一条视频，不能把旧视频进度/播放状态应用到新源。
      if (!mounted || generation !== sourceGeneration || !videoRef.value) return false
      if (Number.isFinite(position)) videoRef.value.currentTime = position
      sourceRefreshAttempted = false
      if (resumePlayback) await videoRef.value.play()
      return true
    } catch (reason) {
      if (mounted && !isAbortError(reason)) error.value = true
      return false
    } finally {
      sourceRefreshPromise = null
    }
  })()
  return sourceRefreshPromise
}

function onError() {
  if (sourceRefreshPromise) return
  if (sourceNeedsRefresh() && props.refreshSrc && !sourceRefreshAttempted) {
    void refreshSource(!videoRef.value?.paused)
    return
  }
  error.value = true
}

function onPlay() {
  playing.value = true
  if (sourceNeedsRefresh() && props.refreshSrc && !sourceRefreshAttempted) {
    void refreshSource(true)
  }
}

async function togglePlay() {
  const v = videoRef.value
  if (!v) return
  if (!v.paused) {
    v.pause()
    showBtn()
    return
  }
  if (sourceNeedsRefresh() && props.refreshSrc && !sourceRefreshAttempted) {
    if (!await refreshSource(false)) return
  }
  try {
    await v.play()
  } catch (reason) {
    // 用户快速暂停、切源或关闭播放器时，浏览器会正常拒绝尚未完成的 play()。
    if (isAbortError(reason)) return
    if (sourceNeedsRefresh() && props.refreshSrc && !sourceRefreshAttempted) {
      await refreshSource(true)
    } else {
      error.value = true
    }
  }
  showBtn()
}

onUnmounted(() => {
  mounted = false
  clearTimeout(hideTimer ?? undefined)
  cancelMetadataWait?.()
})
</script>

<style scoped>
.vv-wrap {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0e0f14;
}

.vv-video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  outline: none;
  print-color-adjust: exact;
  -webkit-print-color-adjust: exact;
}

/* ── 中心按钮容器 ── */
.vv-center-wrap {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 60px;
  height: 60px;
  color: white;
  opacity: 0.75;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.5);
  box-sizing: border-box;
  overflow: hidden;
  transition: transform 0.15s;
}
.vv-center-wrap::before {
  content: '';
  position: absolute;
  inset: 1px;
  border-radius: 50%;
  background: rgba(16, 17, 24, 0.5);
  pointer-events: none;
}
.vv-center-wrap:hover  { transform: translate(-50%, -50%) scale(1.08); }
.vv-center-wrap:active { transform: translate(-50%, -50%) scale(0.94); }

/* ── 按钮 ── */
.vv-center-btn {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: none;
  appearance: none;
  -webkit-appearance: none;
  outline: none;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  pointer-events: auto;
  z-index: 1;
  background: transparent;
  color: white;
  -webkit-tap-highlight-color: transparent;
  transition: color 0.2s;
}
.vv-center-btn svg {
  display: block;
  width: 32px;
  height: 32px;
}
.vv-center-btn :deep(svg.app-icon) {
  width: 32px !important;
  height: 32px !important;
}
.vv-center-wrap:hover .vv-center-btn {
  filter: brightness(1.15);
}
.vv-center-btn:focus,
.vv-center-btn:active {
  outline: none;
  background: transparent;
}

/* ── 淡入淡出 ── */
.vv-btn-enter-active { transition: opacity 0.15s ease; }
.vv-btn-leave-active { transition: opacity 0.1s ease; }
.vv-btn-enter-from,
.vv-btn-leave-to     { opacity: 0; }

/* ── 状态占位 ── */
.vv-status {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  font-size: 13px;
}
.vv-error { color: rgba(200, 180, 160, 0.7); }
</style>
