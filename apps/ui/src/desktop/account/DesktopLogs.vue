<script setup lang="ts">
import DesktopLogSection from './DesktopLogSection.vue'
</script>

<template>
  <DesktopLogSection kind="regular" :title="$t('pageUi.generalLogs')" />
  <div class="pm-sep" aria-hidden="true"></div>
  <DesktopLogSection kind="diagnostic" :title="$t('pageUi.diagnosticLogs')" />
</template>
