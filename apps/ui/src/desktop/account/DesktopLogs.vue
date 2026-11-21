<script setup lang="ts">
import DesktopLogSection from './DesktopLogSection.vue'
</script>

<template>
  <DesktopLogSection kind="regular" title="常规日志" />
  <div class="pm-sep" aria-hidden="true"></div>
  <DesktopLogSection kind="diagnostic" title="诊断日志" />
</template>
