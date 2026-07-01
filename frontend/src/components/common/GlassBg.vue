<script setup lang="ts">
/**
 * GlassBg —— 不依赖 backdrop-filter 的「活玻璃」背景层。
 *
 * 原理：把和 body 同源的页面背景（--bg-gradient）用 background-attachment:fixed【视口锚定】铺一层，
 * 于是它显示的正是「该元素背后那一块背景」，和真 backdrop-filter 玻璃卡同色、同位；再叠一层磨砂白
 * tint。全程不用 backdrop-filter，也不实时采样会动的内容，因此没有 Chrome backdrop-filter 在动
 * 内容之上的边缘重栅格白带（见踩坑记录）。跨引擎（Blink/WebKit/WebView2）一致、零逐帧成本。
 *
 * 为什么不加 CSS filter:blur：当前背景是平滑渐变，本就无高频细节可模糊，直接铺对齐的渐变即等价于
 * 「模糊后的渐变」，和真玻璃卡观感一致。且 filter 与 background-attachment:fixed 在 Chrome 冲突
 * （filter 会使 fixed 背景相对自身定位、对齐失效）。
 *
 * 用法：放在一个【自身 overflow:hidden + 有圆角(含 corner-shape)】的宿主里作首个子元素，宿主背景设
 * transparent、且 isolation:isolate 建层叠上下文。本组件以 z-index:-1 压在宿主内容之下；裁剪交给
 * 宿主（用宿主自己的 squircle 圆角，避免圆角对不齐）——前提是宿主内的下拉/浮层是 Teleport 出去的。
 *
 * 将来接【自定义照片壁纸】：把壁纸在服务端/canvas 预模糊成一张图片资源，用该资源替换这里的
 * background（仍 background-attachment:fixed、不加 CSS filter）即可——既对齐又已模糊。只改一处变量，
 * 顶栏/工具栏等所有用了 GlassBg 的地方自动跟随。
 *
 * 可调（在宿主上设 CSS 变量）：--gb-tint 磨砂白 tint，默认 var(--glass-bg)。
 */
</script>

<template>
  <div class="glass-bg" aria-hidden="true">
    <div class="gb-fill"></div>
    <div class="gb-tint"></div>
  </div>
</template>

<style scoped>
.glass-bg {
  position: absolute;
  inset: 0;
  z-index: -1;            /* 压在宿主内容之下（宿主需 isolation:isolate）；裁剪由宿主 overflow 负责 */
  pointer-events: none;
}
.gb-fill {
  position: absolute;
  inset: 0;
  background: var(--bg-gradient);
  background-attachment: fixed;   /* 视口锚定 → 显示「宿主背后那块背景」，与真玻璃卡同色同位 */
}
.gb-tint {
  position: absolute;
  inset: 0;
  background: var(--gb-tint, var(--glass-bg));
  /* 玻璃亮边高光：GlassBg 不透明填充会盖住宿主 .glass-card 自身的 inset 高光，这里补回，
     和其他玻璃卡一致的「上沿高光 + 左沿高光」。inset 阴影静态、不随交互变，无重绘白带之虞。*/
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.95),
              inset 1px 0 0 rgba(255,255,255,0.55);
}
</style>
