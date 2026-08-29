<template>
  <div class="brand" :class="`brand--${variant}`">
    <div class="brand-mark" aria-hidden="true">
      <img v-if="variant === 'auth'" src="/logo-large2.png" alt="" />
      <span v-else class="brand-mark-mask" />
    </div>
    <div class="brand-content">
      <img v-if="variant === 'auth'" class="brand-wordmark" src="/logo-text2.png" alt="咕咕" />
      <span v-else class="brand-wordmark-mask" aria-label="咕咕" />
      <span v-if="subtitle" class="brand-subtitle">{{ subtitle }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  variant?: 'auth' | 'sidebar' | 'admin'
  subtitle?: string
}>(), {
  variant: 'sidebar',
})
</script>

<style scoped>
.brand {
  display: flex;
  align-items: center;
  color: var(--brand-logo-color);
}

.brand-mark,
.brand-wordmark,
.brand-mark-mask,
.brand-wordmark-mask {
  display: block;
  flex-shrink: 0;
  object-fit: contain;
}

.brand-mark-mask,
.brand-wordmark-mask {
  background: var(--brand-logo-color);
  -webkit-mask-mode: alpha;
  -webkit-mask-position: center;
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-size: contain;
  mask-mode: alpha;
  mask-position: center;
  mask-repeat: no-repeat;
  mask-size: contain;
}

.brand-mark-mask {
  width: 100%;
  height: 100%;
  -webkit-mask-image: url('/logo-small.png');
  mask-image: url('/logo-small.png');
}

.brand-wordmark-mask {
  width: 100%;
  height: 100%;
  -webkit-mask-image: url('/logo-text.png');
  mask-image: url('/logo-text.png');
}

.brand--auth .brand-mark,
.brand--auth .brand-wordmark {
  filter: var(--brand-logo-filter, brightness(0) saturate(100%) invert(48%) sepia(12%) saturate(1060%) hue-rotate(198deg) brightness(88%) contrast(88%));
}

.brand-mark img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: contain;
}

.brand-content {
  display: flex;
  flex-direction: column;
  line-height: 1;
}

.brand-subtitle {
  color: var(--content-muted);
  font-size: var(--font-size-xs);
  margin-top: 4px;
}

.brand--auth {
  position: relative;
  justify-content: center;
  margin-bottom: 18px;
}

.brand--auth::before {
  content: '';
  position: absolute;
  inset: 18% 4%;
  z-index: 0;
  border-radius: 50%;
  background: linear-gradient(135deg,
    color-mix(in srgb, var(--action-primary) 32%, transparent),
    color-mix(in srgb, var(--action-secondary) 28%, transparent));
  filter: blur(22px);
  opacity: 0.8;
}

.brand--auth .brand-mark,
.brand--auth .brand-content {
  position: relative;
  z-index: 1;
}

.brand--auth .brand-mark {
  width: 68px;
  height: 68px;
}

.brand--auth .brand-content {
  width: 158px;
  height: 80px;
  justify-content: center;
}

.brand--auth .brand-wordmark {
  width: 158px;
  height: 80px;
}

.brand--sidebar {
  justify-content: center;
  gap: 4px;
  padding: 0 8px;
  margin-bottom: 10px;
}

.brand--sidebar .brand-mark,
.brand--sidebar .brand-mark-mask {
  width: 30px;
  height: 30px;
}

.brand--sidebar .brand-wordmark,
.brand--sidebar .brand-wordmark-mask {
  width: 56px;
  height: 30px;
}

.brand--admin {
  justify-content: center;
  gap: 10px;
  padding: 0 8px;
  margin-bottom: 20px;
}

.brand--admin .brand-mark,
.brand--admin .brand-mark-mask {
  width: 30px;
  height: 30px;
}

.brand--admin .brand-wordmark,
.brand--admin .brand-wordmark-mask {
  width: 42px;
  height: 23px;
}
</style>
