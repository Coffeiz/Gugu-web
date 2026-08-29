<template>
  <div
    class="vv-wrap"
    @mousemove="showBtn"
    @mouseleave="onMouseLeave"
  >
    <video
      ref="videoRef"
      class="vv-video"
      :src="src"
      :controls="visible"
      playsinline
      preload="metadata"
      @error="onError"
      @play="playing = true"
      @pause="playing = false"
      @ended="playing = false"
    />

    <Transition name="vv-btn">
      <div
        v-if="visible && !error"
        class="vv-center-wrap"
        :class="onLight ? 'vv-on-light' : 'vv-on-dark'"
      >
        <div class="vv-btn-ring" />
        <button class="vv-center-btn" @click="togglePlay">
          <Icon name="media.play"  v-if="!playing" :size="28" />
          <Icon name="media.pause" v-else :size="28" />
        </button>
      </div>
    </Transition>

    <div v-if="error" class="vv-status vv-error">
      <Icon name="status.warning" :size="32" style="opacity:.5" />
      <span>视频无法播放（格式不支持）</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue'
import Icon from '@/components/common/Icon.vue'
const props = defineProps({
  src: { type: String, default: null },
})

const videoRef = ref<HTMLVideoElement | null>(null)
const error    = ref(false)
const playing  = ref(false)
const visible  = ref(false)
const onLight  = ref(false)

let hideTimer: ReturnType<typeof setTimeout> | null = null
let sampleTimer: ReturnType<typeof setInterval> | null = null

// ── 亮度采样 ──────────────────────────────────────────
const sampleCanvas = document.createElement('canvas')
sampleCanvas.width  = 32
sampleCanvas.height = 32
const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true })!

function sampleLuminance() {
  const v = videoRef.value
  if (!v || v.readyState < 2 || !v.videoWidth) return
  try {
    // 取视频中心 20% 区域
    const vw = v.videoWidth, vh = v.videoHeight
    const sw = vw * 0.2, sh = vh * 0.2
    sampleCtx.drawImage(v, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, 32, 32)
    const d = sampleCtx.getImageData(0, 0, 32, 32).data
    let sum = 0
    for (let i = 0; i < d.length; i += 4) {
      sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    }
    onLight.value = sum / (d.length / 4) > 128
  } catch {
    // 跨域视频无法读取像素，保持默认深色模式
  }
}

// ── 显示 / 隐藏 ───────────────────────────────────────
function showBtn() {
  visible.value = true
  clearTimeout(hideTimer ?? undefined)
  hideTimer = setTimeout(() => { visible.value = false }, 1000)
  if (!sampleTimer) {
    sampleLuminance()
    sampleTimer = setInterval(sampleLuminance, 300)
  }
}

function onMouseLeave() {
  clearTimeout(hideTimer ?? undefined)
  clearInterval(sampleTimer ?? undefined)
  sampleTimer = null
  visible.value = false
}

// ── 视频控制 ──────────────────────────────────────────
watch(() => props.src, () => {
  error.value   = false
  playing.value = false
  if (videoRef.value) videoRef.value.load()
})

function onError() { error.value = true }

function togglePlay() {
  const v = videoRef.value
  if (!v) return
  v.paused ? v.play() : v.pause()
  showBtn()
}

onUnmounted(() => {
  clearTimeout(hideTimer ?? undefined)
  clearInterval(sampleTimer ?? undefined)
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
  color-adjust: exact;
  -webkit-color-adjust: exact;
}

/* ── 中心按钮容器 ── */
.vv-center-wrap {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 56px;
  height: 56px;
  transition: transform 0.15s;
}
.vv-center-wrap:hover  { transform: translate(-50%, -50%) scale(1.08); }
.vv-center-wrap:active { transform: translate(-50%, -50%) scale(0.94); }

/* ── 描边 ── */
.vv-btn-ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 2.5px solid currentColor;
  opacity: 0.5;
  pointer-events: none;
  z-index: 2;
  transition: border-color 0.2s;
}

/* ── 按钮 ── */
.vv-center-btn {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  pointer-events: auto;
  z-index: 1;
  transition: background 0.2s, color 0.2s;
}
.vv-center-btn svg { display: block; }
.vv-center-wrap:hover .vv-center-btn { filter: brightness(1.15); }

/* 深色背景 → 白色按钮 */
.vv-on-dark  { color: white; opacity: 0.55; }
.vv-on-dark .vv-center-btn  {
  background: linear-gradient(135deg, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0.08) 100%);
  color: white;
}

/* 浅色背景 → 黑色按钮 */
.vv-on-light { color: black; opacity: 0.55; }
.vv-on-light .vv-center-btn {
  background: linear-gradient(135deg, rgba(0,0,0,0.14) 0%, rgba(0,0,0,0.05) 100%);
  color: black;
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
