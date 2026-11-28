<template>
  <svg width="0" height="0" aria-hidden="true" class="desktop-backdrop-definitions">
    <defs>
      <filter id="desktop-backdrop-alpha" color-interpolation-filters="sRGB">
        <feComponentTransfer>
          <feFuncA type="linear" slope="2" />
        </feComponentTransfer>
      </filter>
    </defs>
  </svg>
</template>

<style scoped>
.desktop-backdrop-definitions { position: absolute; pointer-events: none; }
</style>
