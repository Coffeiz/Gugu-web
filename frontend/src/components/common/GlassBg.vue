<script setup lang="ts">
/**
 * GlassBg —— 不依赖 backdrop-filter 的「活玻璃」背景层。
 *
 * 原理：取和 body 同源的页面背景（--bg-gradient），用【普通】filter:blur 预模糊。普通 filter 有
 * 栅格缓存、且不做「实时采样背后动态内容」，因此没有 Chrome backdrop-filter 在动内容之上的边缘
 * 重栅格白带（见踩坑记录）。背景静态 → 模糊结果可缓存 → 每帧零成本，跨引擎（Blink/WebKit/
 * WebView2）表现一致。
 *
 * 注：background-attachment:fixed（视口锚定、与背景像素级对齐）和同元素的 filter 在 Chrome 会
 * 冲突（filter 使 fixed 背景改为相对自身定位）。当前背景是平滑渐变，局部 cover 的模糊结果与视口
 * 对齐几乎无差别，故用元素内局部渐变即可。将来接入【照片壁纸】需像素级对齐时，改走「服务端/canvas
 * 预模糊成图片资源 → 用该资源 + background-attachment:fixed（不加 CSS filter）」，即可对齐又已模糊。
 *
 * 用法：放在一个 position:relative/absolute + isolation:isolate 的宿主里作【首个子元素】，宿主
 * 背景设 transparent。本组件用 z-index:-1 压在宿主内容之下，且自带 overflow:hidden 裁剪（不会
 * 夹住宿主里的下拉/浮层，因为裁剪只发生在本组件内部）。
 *
 * 适合「浮在会动内容之上」的元素（顶栏、日历工具栏等）——这类元素用 backdrop-filter 会闪白带。
 * 将来接入自定义壁纸：只改 body 的 --bg-gradient（本组件同源引用），玻璃自动跟随。
 *
 * 可调（在宿主上设 CSS 变量）：
 *   --gb-blur   模糊半径，默认 24px
 *   --gb-sat    饱和度（Apple 材质配方，模糊后提饱和防发灰），默认 1.8
 *   --gb-tint   磨砂白 tint，默认 var(--glass-bg)
 */
</script>

<template>
  <div class="glass-bg" aria-hidden="true">
    <div class="gb-blur"></div>
    <div class="gb-tint"></div>
  </div>
</template>

<style scoped>
.glass-bg {
  position: absolute;
  inset: 0;
  z-index: -1;            /* 压在宿主内容之下（宿主需 isolation:isolate 建立层叠上下文） */
  overflow: hidden;       /* 裁剪只发生在这里，不影响宿主的下拉/浮层 */
  border-radius: inherit;
  pointer-events: none;
}
.gb-blur {
  position: absolute;
  inset: -60px;           /* 放大：让 blur 的软边落在裁剪区之外，边缘不发虚 */
  background: var(--bg-gradient);
  background-size: cover;
  background-position: center;
  filter: blur(var(--gb-blur, 24px)) saturate(var(--gb-sat, 1.8));
}
.gb-tint {
  position: absolute;
  inset: 0;
  background: var(--gb-tint, var(--glass-bg));
}
</style>
