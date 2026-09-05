<script setup lang="ts">
import { computed } from 'vue'
import { iconSizes, type IconSizeValue, type IconTone } from './iconTypes'
import { resolveIcon } from './iconRegistry'

const props = withDefaults(defineProps<{
  name: string
  size?: IconSizeValue
  tone?: IconTone
  title?: string
  decorative?: boolean
}>(), {
  size: 'md',
  tone: 'inherit',
  title: undefined,
  decorative: true,
})

const icon = computed(() => resolveIcon(props.name))
const sizeValue = computed(() => (
  typeof props.size === 'string' && props.size in iconSizes
    ? iconSizes[props.size as keyof typeof iconSizes]
    : typeof props.size === 'number' ? String(props.size) : props.size
))
const ariaHidden = computed(() => (props.decorative && !props.title ? 'true' : undefined))
// 全局样式把 .app-icon 定死为 width/height: 1em（随 font-size 缩放），会覆盖 remixicon
// 组件写在 svg 属性上的 width/height。命名尺寸走 --icon-size-* 的 font-size 没问题，
// 数字尺寸必须内联 font-size，否则实际渲染大小≈继承字号（86px 的大图标缩成小点）。
const numericSizeStyle = computed(() =>
  typeof props.size === 'number' ? { fontSize: `${props.size}px` } : undefined)
</script>

<template>
  <component
    :is="icon"
    class="app-icon"
    :class="[`app-icon--${size}`, `app-icon--${tone}`]"
    :size="sizeValue"
    :style="numericSizeStyle"
    :aria-hidden="ariaHidden"
    :aria-label="title"
    :title="title"
  />
</template>
