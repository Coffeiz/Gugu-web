<template>
  <div
    class="drawer-shell canvas-drawer glass-card"
    :class="[{ open, 'project-panel': panelClass === 'project-panel' }, panelClass]"
    :style="{ '--drawer-width': width, '--drawer-height': `${targetHeight}px` }"
  >
    <div class="drawer-shell-header">
      <slot name="header" />
    </div>
    <div class="drawer-shell-collapse" :style="{ height: open ? `${targetHeight}px` : '0px' }">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps({
  open: { type: Boolean, default: false },
  width: { type: String, default: '190px' },
  targetHeight: { type: Number, default: 0 },
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
.drawer-shell-collapse { position: relative; width: 100%; overflow: hidden; transition: height .2s cubic-bezier(.22,1,.36,1); }
.drawer-shell-header { display: flex; align-items: center; height: var(--canvas-toolbar-height); flex-shrink: 0; transition: height .38s cubic-bezier(.22,1,.36,1); }
.drawer-shell:not(.open) .drawer-shell-header { height: calc(var(--canvas-toolbar-height) * 2); flex-direction: column; }
</style>
