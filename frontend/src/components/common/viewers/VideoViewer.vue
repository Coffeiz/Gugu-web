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
    ></video>

    <Transition name="vv-btn">
      <div
        v-if="visible && !error"
        class="vv-center-wrap"
      >
        <div class="vv-btn-ring"></div>
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
// @ts-ignore 当前环境未解析到 vue 类型声明（依赖未安装或 tsconfig 未配置时忽略）
import { ref, watch, onUnmounted } from 'vue'
import Icon from '@/components/common/icons/Icon.vue'
// @ts-ignore 当前环境未解析到 vue-i18n 类型声明
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
const props = defineProps({
  src: { type: String, default: null },
})

const videoRef = ref<HTMLVideoElement | null>(null)
const error    = ref(false)
const playing  = ref(false)
const visible  = ref(false)

let hideTimer: ReturnType<typeof setTimeout> | null = null

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
  opacity: 0.72;
  border-radius: 50%;
  background: rgba(16, 17, 24, 0.24);
  backdrop-filter: blur(24px) saturate(135%);
  -webkit-backdrop-filter: blur(24px) saturate(135%);
  box-shadow: var(--elevation-card);
  transition: transform 0.15s, box-shadow 0.2s;
}
.vv-center-wrap:hover  { transform: translate(-50%, -50%) scale(1.08); }
.vv-center-wrap:active { transform: translate(-50%, -50%) scale(0.94); }

/* ── 描边 ── */
.vv-btn-ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 2px solid currentColor;
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
.vv-center-wrap:hover {
  box-shadow: var(--elevation-card-hover);
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
