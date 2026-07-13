<template>
  <!-- 画布贴纸右上角的操作按钮槽（活动/文件/项目引用卡共用，便签走 NoteCard.vue 自己的
       nc-actions，不在这份范围内）。按钮内容（各卡语义不同，目前都只有一个"移除"）用默认
       插槽传入，这里只统一"槽位定位 + 悬停才显形 + 按钮默认透明只在悬停按钮本身才显色"这套
       外观——之前四个文件各抄一份，稍微跑偏就会出现"删除按钮默认带一层白底像个常驻边框"
       这类不一致（文件卡最先被发现，其实活动/项目卡也一样）。 -->
  <div class="card-actions" :class="{ hovering }">
    <slot></slot>
  </div>
</template>

<script setup lang="ts">
defineProps<{ hovering: boolean }>()
</script>

<style scoped>
.card-actions { position: absolute; top: 8px; right: 8px; z-index: 5; display: flex; gap: 3px; opacity: 0; transition: opacity 0.15s; }
.card-actions.hovering { opacity: 1; }
/* :slotted 而不是 :deep()——按钮是宿主传进来的插槽内容，不是这个组件自己模板里的元素，
   普通 scoped 选择器够不到，:deep() 是"往下钻进任意后代组件"，语义上过宽；:slotted() 专门
   对应"这份插槽塞进来的内容"，更贴切。 */
.card-actions :slotted(button) {
  display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px;
  border: 0; border-radius: 5px; background: transparent; color: var(--text-secondary); cursor: pointer;
}
.card-actions :slotted(button:hover) { background: rgba(123,127,178,.16); color: var(--color-primary); }
</style>
