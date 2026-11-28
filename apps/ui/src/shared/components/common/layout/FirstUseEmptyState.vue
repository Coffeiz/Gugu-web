<template>
  <div class="first-use-empty" role="status">
    <span class="first-use-empty__icon" aria-hidden="true"><slot name="icon" /></span>
    <strong class="first-use-empty__title">{{ title }}</strong>
    <span v-if="description" class="first-use-empty__description">{{ description }}</span>
    <slot />
  </div>
</template>

<script setup lang="ts">
defineProps({
  title: { type: String, required: true },
  description: { type: String, default: '' },
})
</script>

<style scoped>
.first-use-empty {
  box-sizing: border-box;
  display: flex;
  flex: 1 0 auto;
  min-inline-size: 0;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding: 28px 18px;
  text-align: center;
}
.first-use-empty__icon {
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  margin-bottom: 3px;
  border: 1px solid color-mix(in srgb, var(--color-primary) 18%, transparent);
  border-radius: 16px;
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
  color: var(--color-primary);
}
.first-use-empty__title {
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 650;
  line-height: 1.45;
}
.first-use-empty__description {
  max-width: var(--empty-description-width, 260px);
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.6;
}
</style>

<style>
.empty-state-viewport {
  display: flex;
  flex-direction: column;
}
</style>
