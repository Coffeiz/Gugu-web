<template>
  <div class="stat-card glass-card">
    <div class="stat-label">{{ label }}</div>
    <div class="stat-value">{{ value }}</div>
    <div class="stat-sub">
      <span :class="subClass">{{ subPrefix }}</span>
      {{ subText }}
    </div>
    <div class="stat-glow" :style="{ background: glowColor }" />
  </div>
</template>

<script setup>
defineProps({
  label:     String,
  value:     [String, Number],
  subPrefix: String,
  subText:   String,
  subClass:  { type: String, default: 'up' },
  glowColor: { type: String, default: 'rgba(123,127,178,0.15)' },
})
</script>

<style scoped>
.stat-card {
  padding: 18px 20px;
  position: relative;
  overflow: hidden;
  cursor: default;
}
.stat-label {
  font-size: 12px;
  color: var(--text-secondary);
  font-weight: 500;
  margin-bottom: 8px;
}
.stat-value {
  font-size: 30px;
  font-weight: 800;
  line-height: 1;
  color: var(--text-primary);
}
.stat-sub {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 7px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.stat-sub .up   { color: var(--color-success); font-weight: 600; }
.stat-sub .warn { color: var(--color-warning); font-weight: 600; }

.stat-glow {
  position: absolute;
  top: -20px; right: -20px;
  width: 80px; height: 80px;
  border-radius: 50%;
}
</style>
