<template>
  <FolderCard ref="cardRef" v-bind="forwardedAttrs"
    :display-name="String(cardProps.displayName ?? '')">
    <template #icon><slot name="icon" /></template>
    <template #name><slot name="name" /></template>
    <template #count><slot name="count" /></template>
    <template #actions><slot name="actions" /></template>
  </FolderCard>
</template>

<script setup lang="ts">
import { computed, ref, useAttrs, watch, type PropType } from 'vue'
import FolderCard from '@/components/common/file-browser/FolderCard.vue'
import { useObject, type ObjectTargetOptions } from '@/interaction/runtime/vue'

defineOptions({ inheritAttrs: false })

const props = defineProps({
  cardProps: { type: Object as PropType<Record<string, unknown>>, required: true },
  runtimeId: { type: String, required: true },
  runtimeType: { type: String, default: 'folder-item' },
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

const cardRef = ref<InstanceType<typeof FolderCard> | null>(null)
watch(cardRef, card => { elementRef.value = card?.rootEl ?? null }, { immediate: true })
</script>
