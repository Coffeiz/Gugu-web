<template>
  <div class="ai-fab-shell" :class="{ 'ai-fab-shell--playing': rippleActive }" :style="{ zIndex: fabZ }">
    <button class="ai-fab" :class="{ 'ai-fab--playing': rippleActive }" @click="$emit('click')" :title="t('chatUi.gugu')">
      <span ref="svgRef"
            class="ai-fab-logo"
            :class="{ 'ai-fab-spin': hasAudioFile && !spinningBack, 'ai-fab--typing': fabJumping }"
            :style="hasAudioFile && !spinningBack ? { animationPlayState: audioPlaying ? 'running' : 'paused' } : {}"
            aria-hidden="true" />
    </button>
  </div>
</template>

<script setup lang="ts">
/**
 * 悬浮球：纯展示 + 点击转发。转圈/涟漪/打字跳动都是外部状态驱动。
 * Design 页的 GuguChatMock 与这里共享同一组 --gugu-fab-* 令牌，避免样板另画一套。
 */
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'

defineProps<{
  rippleActive: boolean
  fabZ: number
  hasAudioFile: boolean
  spinningBack: boolean
  fabJumping: boolean
  audioPlaying: boolean
}>()
const { t } = useI18n()

defineEmits<{ click: [] }>()

const svgRef = ref<HTMLElement | null>(null)
defineExpose({ svgEl: computed(() => svgRef.value) })
</script>

<style scoped>
.ai-fab {
  position: relative;
  z-index: 1;
  width: var(--gugu-fab-size);
  height: var(--gugu-fab-size);
  border-radius: 50%;
  background: var(--gugu-fab-bg);
  border: 1px solid var(--gugu-fab-border);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--gugu-fab-shadow);
  transition:
    transform var(--motion-hover-control) var(--motion-ease-standard),
    box-shadow var(--motion-hover-control) var(--motion-ease-standard),
    background-color var(--motion-hover-control) var(--motion-ease-standard),
  border-color var(--motion-hover-control) var(--motion-ease-standard);
}
.ai-fab-shell {
  position: fixed;
  right: var(--floating-edge);
  bottom: var(--floating-edge);
  isolation: isolate;
  width: var(--gugu-fab-size);
  height: var(--gugu-fab-size);
}
.ai-fab-shell--playing::before,
.ai-fab-shell--playing::after {
  content: '';
  position: absolute;
  z-index: 0;
  inset: 0;
  border-radius: 50%;
  border: 1.5px solid var(--gugu-fab-ripple);
  pointer-events: none;
  animation: fab-ripple 3.6s ease-out infinite;
}
.ai-fab-shell--playing::after { animation-delay: 1.8s; }
.ai-fab:hover {
  transform: scale(1.08);
  box-shadow: var(--gugu-fab-hover-shadow);
}
.ai-fab:focus-visible { outline: none; box-shadow: var(--gugu-fab-hover-shadow), var(--control-focus-shadow); }
.ai-fab-logo { position:relative; left:1px; z-index:1; width:var(--gugu-fab-logo-size); height:var(--gugu-fab-logo-size); display:block; background:linear-gradient(135deg,rgba(255,255,255,.98),rgba(255,255,255,.78)); -webkit-mask-image:url('/logo-small.png'); -webkit-mask-mode:alpha; -webkit-mask-position:center; -webkit-mask-repeat:no-repeat; -webkit-mask-size:contain; mask-image:url('/logo-small.png'); mask-mode:alpha; mask-position:center; mask-repeat:no-repeat; mask-size:contain; }
.ai-fab-spin { animation: fab-spin 8s linear infinite; transform-origin: center; }
@keyframes fab-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes fab-ripple { 0% { transform: scale(.4); opacity: .8; } 100% { transform: scale(1.55); opacity: 0; } }
@keyframes fab-typing { 0% { transform: translateY(0); } 50% { transform: translateY(-2px); } 100% { transform: translateY(0); } }
.ai-fab--typing { animation: fab-typing .2s linear 1; }
</style>
