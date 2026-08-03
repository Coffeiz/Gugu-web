<template>
  <!-- 遮罩与卡片是平级 fixed 节点（不 Teleport：fixed 同属 root stacking context，
       z 可与 body 下的预览窗等直接比较） -->
  <!-- 遮罩：固定低带（OVERLAY_Z），在一切浮动窗口之下——blur 只糊页面，糊不到预览器/聊天窗 -->
  <Transition name="bm-ov">
    <div v-if="show" class="bm-overlay" :style="{ zIndex: OVERLAY_Z }" @click="$emit('close')" />
  </Transition>
  <!-- 卡片：进窗口带，点击置顶（与预览窗/聊天窗自由叠放）。
       :duration 定时收尾——进场根节点自身没有任何过渡属性（见下方过渡注释），
       不给固定时长的话 Vue 监听不到 transitionend、会立刻摘掉 enter-active，
       玻璃 ramp 就跑不完。 -->
  <Transition name="bm" :duration="{ enter: MODAL_ENTER_MS, leave: MODAL_LEAVE_MS }">
    <div v-if="show" class="bm-center" :style="{ zIndex: myZ }">
      <div class="bm-card" :style="cardStyle" @mousedown.capture="raise">
        <slot />
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { OVERLAY_Z, nextZ, raisePopoversAbove, registerEsc } from '@/composables/windowz'

const props = defineProps({
  show:    { type: Boolean, default: false },
  width:   { type: String,  default: '560px' },
  // 传入则作为固定高度上限（height:100% + max-height），不传则高度随内容自适应
  height:  { type: String,  default: null },
  // 卡片背景：不传=透明（双栏弹窗自己叠玻璃背景，如 ProjectModal）；单栏弹窗传
  // var(--panel-bg) 等撑起整卡底色。用 prop 而非调用方 :deep(.bm-card) 覆盖——
  // BaseModal 是多根组件（.bm-overlay + .bm-center 两个平级根），:deep() 的父作用域
  // 属性只挂在组件根节点上，穿不到 .bm-card 这层（.bm-center 的子节点），调用方的
  // :deep(.bm-card) 选择器实测完全不命中该元素（不是被覆盖，是根本没匹配上）。
  background: { type: String, default: '' },
  blur:       { type: String, default: '' },   // 同理，不传走 CSS 默认 var(--glass-blur)
})

const emit = defineEmits(['close'])

const MODAL_ENTER_MS = 240
const MODAL_LEAVE_MS = 180

const cardStyle = computed(() => ({
  maxWidth: props.width,
  ...(props.height
    ? { height: '100%', maxHeight: props.height }
    : { maxHeight: 'calc(100vh - 48px)' }),
  ...(props.background ? { background: props.background } : {}),
  ...(props.blur ? { backdropFilter: props.blur, WebkitBackdropFilter: props.blur } : {}),
}))

// 窗口层级：打开领新 z、mousedown 置顶；ESC 统一走 windowz（只关最顶层）
const myZ = ref(0)
function raise() {
  myZ.value = nextZ()
  raisePopoversAbove(myZ.value)
}

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

/* ── 卡片 ──
   不设背景色：交给调用方走 background/blur prop（原因见上方 props 定义处的注释）。
   双栏弹窗（如 ProjectModal）各栏自带玻璃背景、不传 background，bm-card 本身透明，
   让各栏的 backdrop-filter 直接穿透到页面。 */
.bm-card {
  pointer-events: auto;
  position: relative;
  width: 100%;
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid rgba(255, 255, 255, 0.72);
  border-radius: 20px;
  box-shadow: 0 24px 64px rgba(20, 25, 50, 0.2),
              inset 0 1px 0 rgba(255, 255, 255, 0.95),
              inset 1px 0 0 rgba(255, 255, 255, 0.55);
  display: flex; flex-direction: column;
  overflow: hidden;
}

/* ── 过渡 ──
   ⚠️ 进场绝不能动 opacity（卡片或它的任何祖先）：CSS 规范里 opacity<1 的元素是一个
   隔离组（backdrop root），其子孙的 backdrop-filter 在整个淡入期间只能在组内采样、
   糊不到组外的页面/窗口（如叠在下面的 GuguChat 大窗口），表现为「打开动画全程不
   模糊、动画结束的一瞬间才突然糊上」（性能 trace 帧序列实测确认）。之前试过的
   will-change 预热/双 rAF 都治不了，因为不是算得慢、是被隔离。
   进场改成「玻璃 ramp」：遮罩的压暗+模糊、卡片/玻璃面板的 blur 半径本身从 0 过渡
   到满值，全程无半透明祖先，采样从第一帧就是活的。面板部分的 ramp 规则在
   global.css（scoped 样式够不到 slot 里的玻璃面板）。
   离场保留 opacity 淡出：关闭瞬间模糊失效会被同步的淡出盖住，肉眼基本不可察。 */
.bm-ov-enter-active {
  transition: background-color var(--modal-enter-duration) var(--modal-enter-easing),
              backdrop-filter var(--modal-enter-duration) var(--modal-enter-easing),
              -webkit-backdrop-filter var(--modal-enter-duration) var(--modal-enter-easing);
}
.bm-ov-leave-active { transition: opacity var(--modal-leave-duration) var(--modal-leave-easing); }
.bm-ov-enter-from {
  background-color: rgba(20, 22, 30, 0);
  backdrop-filter: blur(0px);
  -webkit-backdrop-filter: blur(0px);
}
.bm-ov-leave-to { opacity: 0; }

/* 不能直接淡化 .bm-card：opacity 会让它成为 backdrop root，子面板在动画期间采不到
   外部背景。改由卡片内部遮罩淡出，视觉上原地渐显，同时保留完整的毛玻璃采样。 */
.bm-card::after {
  content: '';
  position: absolute; inset: 0; z-index: 999;
  background: var(--panel-bg);
  opacity: 0; pointer-events: none;
}
.bm-enter-active .bm-card::after {
  transition: opacity var(--modal-enter-duration) var(--modal-enter-easing);
}
.bm-enter-from .bm-card::after { opacity: 1; }
.bm-leave-active { transition: opacity var(--modal-leave-duration) var(--modal-leave-easing); }
.bm-leave-to { opacity: 0; }
</style>
