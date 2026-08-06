<template>
  <button class="ai-fab" :class="{ 'ai-fab--playing': rippleActive }" :style="{ zIndex: fabZ }" @click="$emit('click')" title="咕咕">
    <svg ref="svgRef"
         :class="{ 'ai-fab-spin': hasAudioFile && !spinningBack, 'ai-fab--typing': fabJumping }"
         :style="hasAudioFile && !spinningBack ? { animationPlayState: audioPlaying ? 'running' : 'paused' } : {}"
         width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <path d="M16 7h.01"/>
      <path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20"/>
      <path d="M20 7l2 .5-2 .5"/>
      <path d="M10 18v3"/>
      <path d="M14 17.75V21"/>
    </svg>
  </button>
</template>

<script setup lang="ts">
/**
 * 悬浮球：纯展示 + 点击转发。转圈/涟漪/打字跳动都是外部状态（audioStore.file、
 * spinningBack、fabJumping、rippleActive）驱动的视觉反应，不在这里持有。
 *
 * svgEl 通过 defineExpose 暴露——audioStop() 的转场归位动画需要直接操作这个
 * SVG 元素的 transform/transition（读当前旋转角度、算最短路径转回 0 度），
 * 这段是一次性的 DOM 动画序列，不适合抽成响应式状态，仍由持有 onBeforeStop
 * 回调的一方（GuguChat.vue）直接操作。
 */
import { ref, computed } from 'vue'

defineProps<{
  rippleActive: boolean
  fabZ: number
  hasAudioFile: boolean
  spinningBack: boolean
  fabJumping: boolean
  audioPlaying: boolean
}>()

defineEmits<{ click: [] }>()

const svgRef = ref<SVGSVGElement | null>(null)
defineExpose({ svgEl: computed(() => svgRef.value) })
</script>

<style scoped>
.ai-fab {
  position: fixed; bottom: var(--floating-edge); right: var(--floating-edge);
  isolation: isolate; width: 50px; height: 50px; border-radius: 50%;
  background: linear-gradient(135deg, #7b7fb2, #9590c4); border: none;
  cursor: pointer;   /* z-index 由 :style 动态(fabZ)：默认在窗口带之上，大窗口展开时压到其下 */
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 4px 18px rgba(123,127,178,0.32), inset 0 1px 0 rgba(255,255,255,0.45);
  transition: transform 0.2s, box-shadow 0.2s;
}
.ai-fab:hover { transform: scale(1.08); box-shadow: 0 7px 24px rgba(123,127,178,0.42), inset 0 1px 0 rgba(255,255,255,0.5); }
.ai-fab svg { position: relative; z-index: 1; }
.ai-fab-spin { animation: fab-spin 8s linear infinite; transform-origin: center; }
@keyframes fab-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.ai-fab--playing::before, .ai-fab--playing::after {
  content: ''; position: absolute; inset: 0; border-radius: 50%;
  border: 1.5px solid rgba(123,127,178,0.75); pointer-events: none;
  animation: fab-ripple 3.6s ease-out infinite;
}
.ai-fab--playing::after { animation-delay: 1.8s; }
@keyframes fab-ripple { 0% { transform: scale(0.4); opacity: 0.8; } 100% { transform: scale(1.55); opacity: 0; } }
@keyframes fab-typing {
  0%   { transform: translateY(0); }
  50%  { transform: translateY(-2px); }
  100% { transform: translateY(0); }
}
.ai-fab--typing { animation: fab-typing 0.2s linear 1; }
</style>
