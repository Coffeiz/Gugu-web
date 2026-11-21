<template>
  <svg
    class="flip-chevron"
    :class="[{ open }]"
    :data-dir="direction === 'up-down' ? 'up-down' : undefined"
    :width="size"
    :height="size"
    viewBox="0 0 10 10"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
  >
    <path d="M2 3.5l3 3 3-3" />
  </svg>
</template>

<script setup lang="ts">
/**
 * 统一的开合箭头。默认 right-down：收起朝右、展开转为朝下——全站通用语义，无需传 direction；
 * 个别需要「收起朝下、展开朝上」的下拉场景才显式传 direction="up-down"。
 */
withDefaults(defineProps<{
  open?: boolean
  direction?: 'right-down' | 'up-down'
  size?: number
  transition?: string
}>(), {
  open: false,
  direction: 'right-down',
  size: 9,
  transition: 'transform .2s',
})
</script>

<style scoped>
.flip-chevron {
  flex-shrink: 0;
  color: var(--content-tertiary);
  transform: rotate(-90deg);
  transition: v-bind(transition);
}
.flip-chevron.open { transform: rotate(0deg); }
.flip-chevron[data-dir="up-down"] { transform: none; }
.flip-chevron[data-dir="up-down"].open { transform: rotate(180deg); }
</style>
