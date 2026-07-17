<template>
  <div class="drawer-track">
    <slot />
  </div>
</template>

<style scoped>
.drawer-track { position: relative; width: 100%; min-height: 100%; }
.drawer-track.project-list-scroll::-webkit-scrollbar { width: 3px; }
.drawer-track.project-list-scroll::-webkit-scrollbar-track { background: transparent; }
.drawer-track.project-list-scroll::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.12); border-radius: 99px; }
</style>
