<template>
  <div class="status-dot-wrap" :class="ok ? 'ok' : 'idle'" :title="ok ? '连接正常' : '未测试'">
    <span class="dot" />
    <span class="label">{{ ok ? '已连接' : '未测试' }}</span>
  </div>
</template>

<script setup>
defineProps({ ok: Boolean })
</script>

<style scoped>
.status-dot-wrap {
  display: flex; align-items: center; gap: 5px;
  margin-left: auto;
  font-size: 11px; font-weight: 600;
}
.dot {
  width: 7px; height: 7px; border-radius: 50%;
}
.ok   .dot   { background: var(--color-success); box-shadow: 0 0 0 2px rgba(90,158,136,0.2); }
.idle .dot   { background: rgba(0,0,0,0.2); }
.ok   { color: var(--color-success); }
.idle { color: var(--text-secondary); }
</style>
