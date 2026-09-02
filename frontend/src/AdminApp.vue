<template>
  <RouterView />
  <ConfirmDialog />
</template>

<script setup lang="ts">
import ConfirmDialog from '@/components/common/overlays/ConfirmDialog.vue'
</script>

<style>
/* 非刷新图标按钮仍由 Admin 全局提供基础尺寸；刷新按钮本身由 RefreshButton 管理旋转与状态。 */
.icon-btn {
  width: 34px; height: 34px; border-radius: 9px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--border-subtle); background: var(--surface-glass);
  color: var(--content-secondary); cursor: pointer;
  transition: all var(--motion-fast) var(--motion-ease-standard);
}
.icon-btn:hover { background: var(--surface-glass-hover); color: var(--content-primary); }
.icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
