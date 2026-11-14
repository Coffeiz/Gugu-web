<template>
  <BaseModal :show="show" :width="width" :height="height" @close="$emit('close')">
    <div :class="[rootClass, 'project-modal-root']">
      <slot />
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import BaseModal from '@/components/common/overlays/BaseModal.vue'

defineProps({
  show: { type: Boolean, required: true },
  width: { type: String, default: '1060px' },
  height: { type: String, default: '780px' },
  rootClass: { type: [String, Array, Object], default: 'modal' },
})

defineEmits(['close'])

</script>

<style>
/* ProjectModal 的布局根节点由本组件渲染，不能依赖父组件的 scoped 选择器命中。
   这里仅保留根布局职责，左右栏及其内容样式仍由 ProjectModal/ProjectFilesPanel 管理。 */
.project-modal-root {
  display: flex;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
</style>
