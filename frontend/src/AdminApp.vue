<template>
  <RouterView />
</template>

<style>
/* ── Admin 全局共用（非 scoped，仅 admin 打包加载，不影响前台）────────────────
   统一「刷新/图标按钮」：与邀请码页一致（34×34 方形、PhArrowClockwise、点击转一圈）。
   用法：<button class="icon-btn" :class="{ spinning: refreshing }" title="刷新">
           <PhArrowClockwise :size="15" weight="bold" />
         </button>
   点击时置 refreshing=true、550ms 后复位（动画 0.5s ease-out 转一圈）。 */
.icon-btn {
  width: 34px; height: 34px; border-radius: 9px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05);
  color: rgba(255,255,255,0.5); cursor: pointer; transition: all 0.15s;
}
.icon-btn:hover { background: rgba(255,255,255,0.09); color: rgba(255,255,255,0.8); }
.icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.icon-btn.spinning svg {
  animation: admin-icon-spin 0.5s ease-out;
  transform-box: fill-box; transform-origin: center;
}
@keyframes admin-icon-spin { to { transform: rotate(360deg); } }
</style>
