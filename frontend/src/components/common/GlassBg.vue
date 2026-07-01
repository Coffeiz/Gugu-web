<script setup lang="ts">
/**
 * GlassBg —— 不依赖 backdrop-filter 的「活玻璃」背景层，避免 backdrop-filter 在会动内容之上的
 * 边缘重栅格白带（见踩坑记录）。用于「浮在会动内容上」的元素（顶栏、日历工具栏等）。
 *
 * 当前实现：一层半透明磨砂 tint（+ 亮边高光），让真实页面背景直接透过 → 观感等同
 * 原来的半透明玻璃，但没有 backdrop-filter 因而无白带。跨引擎（Blink/WebKit/WebView2）一致。
 *
 * 用法：放在一个背景 transparent、isolation:isolate 的宿主里作首个子元素；本组件以 z-index:-1
 * 压在宿主内容之下（半透明，故宿主背后的真实背景透过来）。宿主自身 overflow:hidden 用自己的圆角
 * （含 corner-shape）裁剪本组件——前提是宿主内的下拉/浮层是 Teleport 出去的。
 *
 * 将来接【自定义照片壁纸】要真磨砂：在 .gb-tint 之下加一层不透明的「预模糊壁纸」fill——把壁纸在
 * 服务端/canvas 预模糊成图片资源，用 `background: url(...); background-attachment: fixed`（视口锚定
 * 对齐、不加 CSS filter，因 filter 与 fixed 冲突）。只改这一处，所有用了 GlassBg 的地方自动跟随。
 *
 * 可调（宿主上设 CSS 变量）：--gb-tint 磨砂白，默认 var(--glass-bg)。
 */
</script>

<template>
  <div class="glass-bg" aria-hidden="true">
    <div class="gb-tint"></div>
  </div>
</template>

<style scoped>
.glass-bg {
  position: absolute;
  inset: 0;
  z-index: -1;            /* 压在宿主内容之下；半透明 → 宿主背后真实背景透过来。裁剪由宿主 overflow 负责 */
  pointer-events: none;
}
.gb-tint {
  position: absolute;
  inset: 0;
  background: var(--gb-tint, var(--glass-bg));
  /* 亮边高光：与 glass-card 完全一致（上沿 1px/0.95 + 左沿 0.55），静态不重绘、无白带之虞 */
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.95),
    inset 1px 0 0 rgba(255,255,255,0.55);
}
</style>
