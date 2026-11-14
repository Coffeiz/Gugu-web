<template>
  <FileCard ref="cardRef" v-bind="forwardedAttrs"
    :ext="String(cardProps.ext ?? '')" :display-name="String(cardProps.displayName ?? '')">
    <template #thumb><slot name="thumb" /></template>
    <template #name><slot name="name" /></template>
    <template #meta><slot name="meta" /></template>
    <slot />
  </FileCard>
</template>

<script setup lang="ts">
import { computed, ref, useAttrs, watch, type PropType } from 'vue'
import FileCard from './FileCard.vue'
import type { TargetItem } from '@/interaction/runtime'
import { useFileRuntimeObject } from '@/composables/files/useFileRuntimeObject'

defineOptions({ inheritAttrs: false })

const props = defineProps({
  cardProps: { type: Object as PropType<Record<string, unknown>>, required: true },
  runtimeId: { type: String, required: true },
  runtimeType: { type: String, default: 'file-item' },
  runtimeSurfaceId: { type: String, required: true },
  runtimeAbilities: { type: Array as PropType<readonly string[]>, default: () => ['move'] },
  runtimeSelected: { type: Boolean, default: false },
  runtimeTarget: { type: Object as PropType<Omit<TargetItem, 'id' | 'element' | 'generation'> | undefined>, default: undefined },
})
const attrs = useAttrs()
const forwardedAttrs = computed(() => ({ ...attrs, ...props.cardProps }))
const { elementRef } = useFileRuntimeObject(() => props.runtimeId, () => ({
  type: props.runtimeType,
  surfaceId: props.runtimeSurfaceId,
  abilities: props.runtimeAbilities,
  selected: props.runtimeSelected,
  target: props.runtimeTarget,
}))

const cardRef = ref<InstanceType<typeof FileCard> | null>(null)
watch(cardRef, card => { elementRef.value = card?.rootEl ?? null }, { immediate: true })
</script>
