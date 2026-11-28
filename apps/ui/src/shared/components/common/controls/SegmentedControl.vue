<template>
  <div class="seg-control" ref="rootEl">
    <div class="seg-pill" :class="{ ready }" :style="pillStyle" />
    <slot />
  </div>
</template>

<script setup lang="ts">
/**
 * 分段切换器的滑块外壳：只负责量出当前选中项的位置/宽高、把一个绝对定位的药丸块移过去，
 * 不管选项本身长什么样（文字/图标/RouterLink 都行，直接把现成的按钮塞进默认插槽）——
 * 药丸的颜色/圆角/阴影通过 CSS 变量（--pill-bg/--pill-radius/--pill-shadow）从外面传，
 * 三处调用方轨道背景/圆角/间距都不一样，不该被这层组件写死。
 *
 * 用真实 DOM 测量而不是假设等宽分段——文件库是等宽图标方块，但日历/思维画布的选项文字
 * 宽度不一定相等，按 index 算 `translateX(index * 100%)` 会跑偏。
 *
 * 横竖两个方向都用 getBoundingClientRect() 算相对偏移，不用 offsetLeft/offsetTop——
 * 后者的计量基准是 offsetParent 的边框边缘，CSS 绝对定位 `top/left` 的基准却是
 * offsetParent 的 padding 边缘，两者在有 padding 的容器里对不上。用两个元素各自的真实
 * 屏幕矩形做差，天然规避这层基准不一致，不管容器 padding/align-items 怎么设都能量准。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{ activeIndex: number }>()
const rootEl = ref<HTMLElement | null>(null)
const pillStyle = ref<Record<string, string>>({ width: '0px', height: '0px', transform: 'translate(0, 0)' })
// 首次量出准确位置前不参与 CSS 过渡——不然药丸初始值是 (0,0)/0 宽，第一次量出真实位置
// 那次更新会被当成一次「从左上角滑过去」的正常过渡播出来，开屏就有个不该有的滑入动画。
// mount 后连量两帧（rAF 套 rAF）才真正把 ready 打开：第一帧量到的位置可能还没经过浏览器
// 实际一次布局收敛（比如 SVG 图标刚插入、字重渲染），第二帧再量一次校准，两帧都发生在
// ready=false 期间、没有过渡动画，只有第二帧量出的位置才是最终会被拿去做过渡起点的基准。
const ready = ref(false)

function measure() {
  const root = rootEl.value
  if (!root) return
  // 第一个子节点是 .seg-pill 自己，真正的选项从插槽内容开始，即 children[activeIndex + 1]
  const target = root.children[props.activeIndex + 1] as HTMLElement | undefined
  if (!target) return
  const rootRect = root.getBoundingClientRect()
  const rect = target.getBoundingClientRect()
  // getBoundingClientRect 量出来的是边框盒（含边框），但 CSS 绝对定位 top/left:0 默认对齐
  // 的是容器的内边距盒（边框以内）——直接拿两个矩形做差会把边框厚度重复算一次（有边框的
  // 轨道，比如 Mind 的 .mind-tabs，药丸会整体多偏移一个边框宽度）。减掉 clientLeft/clientTop
  // （= 边框厚度，无边框时天然是 0）把参照系对齐成同一个基准。
  const dx = rect.left - rootRect.left - root.clientLeft
  const dy = rect.top - rootRect.top - root.clientTop
  pillStyle.value = {
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    transform: `translate(${dx}px, ${dy}px)`,
  }
}

let ro: ResizeObserver | null = null
onMounted(() => {
  nextTick(() => {
    measure()
    requestAnimationFrame(() => {
      measure()
      requestAnimationFrame(() => { ready.value = true })
    })
  })
  ro = new ResizeObserver(() => measure())
  if (rootEl.value) ro.observe(rootEl.value)
})
onBeforeUnmount(() => ro?.disconnect())
watch(() => props.activeIndex, () => nextTick(measure))
</script>

<style scoped>
.seg-control {
  position: relative;
  display: inline-flex;
  /* 固定高度的选项（如 Files 的 28px 图标方块、Mind 的 36px 标签）在默认 align-items:
     stretch 下不会真的居中——stretch 对已写死高度的子元素会退化成顶对齐，视觉上偏上/偏下
     （取决于容器实际高度跟子元素高度的差值和 padding 怎么分配）。显式居中，不用再靠调
     padding 数值去凑视觉效果。 */
  align-items: center;
}
.seg-pill {
  position: absolute;
  top: 0; left: 0;
  background: var(--pill-bg, var(--selected-pill-bg, var(--segmented-pill-bg, #fff)));
  border-radius: var(--pill-radius, 8px);
  box-shadow: var(--pill-shadow, var(--selected-pill-shadow, var(--segmented-pill-shadow, 0 1px 4px rgba(60,70,100,0.12))));
  pointer-events: none;
  z-index: 0;
}
.seg-pill.ready {
  transition:
    transform var(--motion-hover-card) var(--motion-ease-emphasis),
    width var(--motion-hover-card) var(--motion-ease-emphasis),
    background-color var(--motion-hover-control) var(--motion-ease-standard),
    box-shadow var(--motion-hover-control) var(--motion-ease-standard);
}
/* 插槽内容（按钮/RouterLink）必须盖在药丸之上——绝对定位元素默认按「先绝对定位者优先」
   的规则渲染在最上层，不管 DOM 顺序，静态定位的插槽内容反而会被压在底下。插槽内容带的是
   调用方的 scoped 属性，不是本组件的，普通选择器选不中，得用 :deep()。 */
.seg-control > :deep(:not(.seg-pill)) {
  position: relative;
  z-index: 1;
}
</style>