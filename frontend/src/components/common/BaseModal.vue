<template>
  <Transition name="bm" :duration="{ enter: 340, leave: 220 }">
    <div v-if="show" class="bm-wrap" :style="{ zIndex }" @keydown.esc="$emit('close')">
      <div class="bm-overlay" @click="$emit('close')" />
      <div class="bm-card" :style="cardStyle">
        <slot />
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { computed, watch } from 'vue'

const props = defineProps({
  show:    { type: Boolean, default: false },
  width:   { type: String,  default: '560px' },
  // 传入则作为固定高度上限（height:100% + max-height），不传则高度随内容自适应
  height:  { type: String,  default: null },
  zIndex:  { type: Number,  default: 300 },
})

const emit = defineEmits(['close'])

const cardStyle = computed(() => ({
  maxWidth: props.width,
  ...(props.height
    ? { height: '100%', maxHeight: props.height }
    : { maxHeight: 'calc(100vh - 48px)' }),
}))

// Esc 关闭
function onKey(e) { if (e.key === 'Escape') emit('close') }
watch(() => props.show, v => {
  if (v) document.addEventListener('keydown', onKey)
  else   document.removeEventListener('keydown', onKey)
}, { immediate: true })
</script>

<style scoped>
/* ── 容器 ── */
.bm-wrap {
  position: fixed; inset: 0;
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
}

/* ── 遮罩 ── */
.bm-overlay {
  position: absolute; inset: 0;
  background: rgba(20, 22, 30, 0.3);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}

/* ── 卡片 ── */
.bm-card {
  position: relative; z-index: 1;
  width: 100%;
  background: rgba(238, 240, 246, 0.94);
  backdrop-filter: blur(28px);
  -webkit-backdrop-filter: blur(28px);
  border: 1px solid rgba(255, 255, 255, 0.72);
  border-radius: 20px;
  box-shadow: 0 24px 64px rgba(20, 25, 50, 0.2);
  display: flex; flex-direction: column;
  overflow: hidden;
}

/* ── 进入：遮罩和卡片各自淡入 ── */
.bm-enter-active .bm-overlay { transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1); }
.bm-leave-active .bm-overlay { transition: opacity 0.2s cubic-bezier(0.4, 0, 1, 1); }
.bm-enter-from .bm-overlay,
.bm-leave-to   .bm-overlay   { opacity: 0; }

.bm-enter-active .bm-card { transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1); }
.bm-leave-active .bm-card { transition: opacity 0.2s cubic-bezier(0.4, 0, 1, 1); }
.bm-enter-from .bm-card,
.bm-leave-to   .bm-card   { opacity: 0; }
</style>
