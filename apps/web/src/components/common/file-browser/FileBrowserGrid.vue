<template>
  <div class="file-browser-grid" :class="className" :data-layout-collection="layoutCollection" @contextmenu.prevent.self="emit('empty-context', $event)">
    <slot />
  </div>
</template>

<script setup lang="ts">
defineProps({
  className: { type: String, default: 'file-grid' },
  // 目录切换的 Collection Presence 分组标记（Phase 4）：文件页和项目抽屉的文件面板
  // 共用这个容器组件，必须传入互不相同的 collection 名，否则 data-layout-key 的
  // 全局唯一性要求会跨两处浏览区互相干扰。
  layoutCollection: { type: String, default: 'files-browser' },
})
const emit = defineEmits<{ 'empty-context': [event: MouseEvent] }>()
</script>
