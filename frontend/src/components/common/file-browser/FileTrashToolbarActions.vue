<template>
  <template v-if="hasItems">
    <button class="select-all-btn" :class="{ on: allSelected }" @click="emit('toggle-select')" :title="allSelected ? '取消全选' : '全选'">
      {{ allSelected ? '取消全选' : '全选' }}
    </button>
  </template>
  <button class="empty-trash-btn" @click.stop="emit('empty')"><Icon name="action.delete" :size="12" /> 清空回收站</button>
</template>

<script setup lang="ts">
import Icon from '@/components/common/Icon.vue'
defineProps({ hasItems: Boolean, allSelected: Boolean })
const emit = defineEmits<{ 'toggle-select': []; empty: [] }>()
</script>
