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
import FileCard from '@/components/common/file-browser/FileCard.vue'
import { useObject, type ObjectTargetOptions } from '@/interaction/runtime/vue'

defineOptions({ inheritAttrs: false })

const props = defineProps({
  cardProps: { type: Object as PropType<Record<string, unknown>>, required: true },
  runtimeId: { type: String, required: true },
  runtimeType: { type: String, default: 'file-item' },
  runtimeSurfaceId: { type: String, required: true },
  runtimeAbilities: { type: Array as PropType<readonly string[]>, default: () => ['move'] },
  runtimeTarget: { type: Object as PropType<ObjectTargetOptions | undefined>, default: undefined },
})
const attrs = useAttrs()
const forwardedAttrs = computed(() => ({ ...attrs, ...props.cardProps }))

const { elementRef } = useObject({
  id: props.runtimeId,
  type: () => props.runtimeType,
  surface: () => props.runtimeSurfaceId,
  abilities: () => props.runtimeAbilities,
  target: () => props.runtimeTarget,
})

const cardRef = ref<InstanceType<typeof FileCard> | null>(null)
watch(cardRef, card => { elementRef.value = card?.rootEl ?? null }, { immediate: true })
</script>
