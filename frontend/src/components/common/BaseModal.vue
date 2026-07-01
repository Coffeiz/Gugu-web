<template>
  <!-- 遮罩与卡片是平级 fixed 节点（不 Teleport：保住调用方 :deep(.bm-card) 定制；
       fixed 同属 root stacking context，z 可与 body 下的预览窗等直接比较） -->
  <!-- 遮罩：固定低带（OVERLAY_Z），在一切浮动窗口之下——blur 只糊页面，糊不到预览器/聊天窗 -->
  <Transition name="bm-ov">
    <div v-if="show" class="bm-overlay" :style="{ zIndex: OVERLAY_Z }" @click="$emit('close')" />
  </Transition>
  <!-- 卡片：进窗口带，点击置顶（与预览窗/聊天窗自由叠放） -->
  <Transition name="bm">
    <div v-if="show" class="bm-center" :style="{ zIndex: myZ }">
      <div class="bm-card" :style="cardStyle" @mousedown.capture="raise">
        <slot />
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { OVERLAY_Z, nextZ, registerEsc } from '@/composables/windowz'

const props = defineProps({
  show:    { type: Boolean, default: false },
  width:   { type: String,  default: '560px' },
  // 传入则作为固定高度上限（height:100% + max-height），不传则高度随内容自适应
  height:  { type: String,  default: null },
})

const emit = defineEmits(['close'])

const cardStyle = computed(() => ({
  maxWidth: props.width,
  ...(props.height
    ? { height: '100%', maxHeight: props.height }
    : { maxHeight: 'calc(100vh - 48px)' }),
}))

// 窗口层级：打开领新 z、mousedown 置顶；ESC 统一走 windowz（只关最顶层）
const myZ = ref(0)
function raise() { myZ.value = nextZ() }

let unregEsc: (() => void) | null = null
watch(() => props.show, v => {
  if (v) {
    raise()
    unregEsc = registerEsc({ getZ: () => myZ.value, close: () => emit('close') })
  } else {
    unregEsc?.(); unregEsc = null
  }
}, { immediate: true })
onBeforeUnmount(() => unregEsc?.())
</script>

<style scoped>
/* ── 遮罩（独立节点，固定低带）── */
.bm-overlay {
  position: fixed; inset: 0;
  background: rgba(20, 22, 30, 0.3);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}

/* ── 居中容器：不拦截指针（下面的窗口照点），只有卡片本体可交互 ── */
.bm-center {
  position: fixed; inset: 0;
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
  pointer-events: none;
}

/* ── 卡片 ── */
.bm-card {
  pointer-events: auto;
  position: relative;
  width: 100%;
  background: rgba(238, 240, 246, 0.94);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid rgba(255, 255, 255, 0.72);
  border-radius: 20px;
  box-shadow: 0 24px 64px rgba(20, 25, 50, 0.2);
  display: flex; flex-direction: column;
  overflow: hidden;
}

/* ── 过渡：遮罩 / 卡片各自淡入淡出（与原节奏一致）── */
.bm-ov-enter-active { transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1); }
.bm-ov-leave-active { transition: opacity 0.2s cubic-bezier(0.4, 0, 1, 1); }
.bm-ov-enter-from, .bm-ov-leave-to { opacity: 0; }

.bm-enter-active { transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1); }
.bm-leave-active { transition: opacity 0.2s cubic-bezier(0.4, 0, 1, 1); }
.bm-enter-from, .bm-leave-to { opacity: 0; }
</style>
