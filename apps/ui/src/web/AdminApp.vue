<template>
  <RouterView />
  <ConfirmDialog />
</template>

<script setup lang="ts">
import ConfirmDialog from '@/components/common/overlays/ConfirmDialog.vue'
</script>

<style>
/* Admin 页面共享按钮交互：与系统配置页主按钮、次按钮保持一致的淡入淡出反馈。 */
.btn-primary,
.btn-confirm,
.btn-confirm-del {
  transition: background-color var(--motion-hover-control, 150ms) var(--motion-ease-standard, ease),
    border-color var(--motion-hover-control, 150ms) var(--motion-ease-standard, ease),
    color var(--motion-hover-control, 150ms) var(--motion-ease-standard, ease),
    box-shadow var(--motion-hover-control, 150ms) var(--motion-ease-standard, ease),
    opacity var(--motion-hover-control, 150ms) ease,
    filter var(--motion-hover-control, 150ms) var(--motion-ease-standard, ease);
}
.btn-primary:hover:not(:disabled),
.btn-confirm:hover:not(:disabled) {
  filter: brightness(1.1);
}
.btn-ghost,
.toggle-btn,
.btn-cancel,
.btn-test,
.action-btn,
.btn-export,
.page-btn,
.pg-btn {
  transition: background-color var(--motion-hover-control, 150ms) var(--motion-ease-standard, ease),
    border-color var(--motion-hover-control, 150ms) var(--motion-ease-standard, ease),
    color var(--motion-hover-control, 150ms) var(--motion-ease-standard, ease),
    opacity var(--motion-hover-control, 150ms) ease,
    box-shadow var(--motion-hover-control, 150ms) var(--motion-ease-standard, ease);
}

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
