<template>
  <div class="auth-background" aria-hidden="true" />
</template>

<style scoped>
.auth-background {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  background: var(--bg-gradient, linear-gradient(160deg, #e8e9ee 0%, #d8dae4 35%, #bfc4d2 65%, #9aa2b8 100%));
}
</style>
