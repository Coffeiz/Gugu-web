<script setup lang="ts">
const props = defineProps<{ section: string }>()

const labels: Record<string, string> = {
  files: '文件库', terminals: '终端', skills: '技能', mcp: 'MCP',
  customers: '联系人', team: '团队', schedules: '定时任务',
}
</script>

<template>
  <section class="desktop-panel glass-card desktop-coming-soon"><p>{{ labels[props.section] ?? $t('pageUi.thisArea') }} {{ $t('pageUi.desktopComingSoon') }}</p></section>
</template>

<style scoped>
.desktop-coming-soon { margin: 0; }
.desktop-coming-soon p { color: var(--text-secondary); line-height: 1.6; }
</style>
