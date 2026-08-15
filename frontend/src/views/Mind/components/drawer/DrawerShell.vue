<template>
  <div
    ref="rootRef"
    class="drawer-shell canvas-drawer glass-card"
    data-runtime-surface
    data-floating-surface
    data-layout-role="shell"
    data-layout-key="drawer-shell"
    :class="[{ open, 'project-panel': panelClass === 'project-panel' }, panelClass]"
    :style="{ '--drawer-width': open ? width : 'var(--canvas-toolbar-height)' }"
  >
    <slot name="header" />
    <div class="drawer-shell-collapse">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const rootRef = ref<HTMLElement | null>(null)

defineProps({
  open: { type: Boolean, default: false },
  width: { type: String, default: '190px' },
  panelClass: { type: String, default: '' },
})

defineExpose({ rootRef })
</script>

<style scoped>
.drawer-shell {
  position: absolute;
  top: 50%;
  right: var(--floating-edge);
  z-index: 30;
  box-sizing: border-box;
  width: var(--drawer-width);
  overflow: hidden;
  border-radius: 25px;
  corner-shape: round;
  transform: translateY(-50%);
  /* 与 Runtime 的 Surface resize profile 保持同一时长和缓动，避免高度先结束、宽度再滞后。 */
  transition: width .35s cubic-bezier(.22,1,.36,1), border-radius .35s cubic-bezier(.22,1,.36,1), background .35s ease, box-shadow .35s ease;
}
.drawer-shell-collapse { position: relative; width: 100%; overflow: hidden; }
</style>
