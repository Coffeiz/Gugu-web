<template>
  <div class="file-browser-list" :class="className" :data-layout-collection="layoutCollection" @contextmenu.prevent.self="emit('empty-context', $event)">
    <slot />
  </div>
</template>

<script setup lang="ts">
defineProps({
  className: { type: String, default: 'file-list' },
  // 见 FileBrowserGrid.vue 同名 prop 注释：文件页与项目抽屉必须用不同 collection 名。
  layoutCollection: { type: String, default: 'files-browser' },
})
const emit = defineEmits<{ 'empty-context': [event: MouseEvent] }>()
</script>
