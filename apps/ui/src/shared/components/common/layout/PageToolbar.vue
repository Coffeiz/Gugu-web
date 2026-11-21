<template>
  <div class="page-toolbar glass-card">
    <slot />
  </div>
</template>

<style>
.page-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-sizing: border-box;
  flex-shrink: 0;
  position: relative;
  overflow: hidden;
}
.page-toolbar .page-toolbar__action.app-action-button.is-fit {
  min-width: var(--toolbar-action-min-width);
  height: var(--toolbar-compact-control-height);
  min-height: var(--toolbar-compact-control-height);
  padding-block: 0;
  font-size: var(--font-size-sm);
}
</style>
