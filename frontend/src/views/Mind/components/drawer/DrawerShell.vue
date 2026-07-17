<template>
  <div
    class="drawer-shell canvas-drawer glass-card"
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
defineProps({
  open: { type: Boolean, default: false },
  width: { type: String, default: '190px' },
  panelClass: { type: String, default: '' },
})

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
  transition: width .38s cubic-bezier(.22,1,.36,1), border-radius .38s cubic-bezier(.22,1,.36,1), background .25s ease, box-shadow .25s ease;
}
.drawer-shell-collapse { position: relative; width: 100%; overflow: hidden; }
</style>
