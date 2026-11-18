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
</style>
