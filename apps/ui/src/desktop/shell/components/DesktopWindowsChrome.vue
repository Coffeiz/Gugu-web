<script setup lang="ts">
const chrome = (window as Window & { guguWindowChrome?: { platform: string; command(action: string): void } }).guguWindowChrome
const enabled = chrome?.platform === 'win32'
const menus = ['文件', '编辑', '前往', '窗口', '帮助']
</script>

<template>
  <div v-if="enabled" class="windows-chrome">
    <nav class="windows-menus" aria-label="应用菜单">
      <button v-for="menu in menus" :key="menu" type="button" aria-haspopup="menu" @click="chrome?.command(menu)">{{ menu }}</button>
    </nav>
    <div class="windows-controls">
      <button type="button" aria-label="最小化" @click="chrome?.command('minimize')"><svg viewBox="0 0 12 12"><path d="M1 6h10" /></svg></button>
      <button type="button" aria-label="最大化或还原" @click="chrome?.command('maximize')"><svg viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" /></svg></button>
      <button type="button" class="close" aria-label="关闭窗口" @click="chrome?.command('close')"><svg viewBox="0 0 12 12"><path d="m1 1 10 10M11 1 1 11" /></svg></button>
    </div>
  </div>
</template>

<style scoped>
.windows-chrome { position: relative; grid-column: 1 / -1; grid-row: 1; display: flex; align-items: stretch; justify-content: space-between; height: 52px; z-index: 10; pointer-events: none; }
.windows-menus, .windows-controls { display: flex; align-items: center; gap: var(--space-2xs, 2px); pointer-events: auto; app-region: no-drag; -webkit-app-region: no-drag; }
.windows-menus { padding-left: var(--space-md); }
button { pointer-events: auto; app-region: no-drag; -webkit-app-region: no-drag; border: 0; border-radius: var(--radius-xs); height: 34px; transition: background-color 0.15s, color 0.15s; background: transparent; color: var(--text-secondary); font: inherit; font-size: 12px; cursor: default; }
.windows-menus button { padding: 0 12px; }
button:hover { background: var(--surface-soft-hover); color: var(--text-primary); }
button:focus-visible { outline: 2px solid var(--text-secondary); outline-offset: -3px; }
.windows-controls { padding-inline: var(--space-sm); }
.windows-controls button { width: 38px; display: grid; place-items: center; }
.windows-controls svg { width: 10px; height: 10px; fill: none; stroke: currentColor; stroke-width: 1; }
.windows-controls .close:hover { background: var(--close-button-danger-bg); color: var(--close-button-danger-fg); }
</style>
