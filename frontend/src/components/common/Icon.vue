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
</script>

<template>
  <component
    :is="icon"
    class="app-icon"
    :class="[`app-icon--${size}`, `app-icon--${tone}`]"
    :size="sizeValue"
    :aria-hidden="ariaHidden"
    :aria-label="title"
    :title="title"
  />
</template>
