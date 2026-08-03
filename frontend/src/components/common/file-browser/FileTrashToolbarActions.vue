<template>
  <template v-if="hasItems">
    <button class="select-all-btn" :class="{ on: allSelected }" @click="emit('toggle-select')" :title="allSelected ? '取消全选' : '全选'">
      {{ allSelected ? '取消全选' : '全选' }}
    </button>
  </template>
  <button class="empty-trash-btn" @click.stop="emit('empty')"><PhTrash :size="12" weight="bold" /> 清空回收站</button>
</template>

<script setup lang="ts">
import { PhTrash } from '@phosphor-icons/vue'
defineProps({ hasItems: Boolean, allSelected: Boolean })
const emit = defineEmits<{ 'toggle-select': []; empty: [] }>()
</script>

<style scoped>
.select-all-btn { height: 28px; padding: 0 12px; border-radius: 6px; border: none; background: rgba(255,255,255,0.55); cursor: pointer; color: var(--color-primary); font-size: 12px; font-weight: 600; font-family: var(--font-sans); white-space: nowrap; display: flex; align-items: center; transition: background 0.15s, color 0.15s, box-shadow 0.15s; }
.select-all-btn:not(.on):hover { background: rgba(255,255,255,0.82); }
.select-all-btn.on { background: rgba(255,255,255,0.92); color: var(--color-primary); box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
.empty-trash-btn { display: flex; align-items: center; gap: 5px; padding: 6px 12px; border-radius: 8px; border: 1px solid rgba(200,90,90,0.3); background: rgba(200,90,90,0.06); font-size: 12px; font-weight: 500; color: #c85a5a; cursor: pointer; font-family: var(--font-sans); transition: all 0.15s; }
.empty-trash-btn:hover { background: rgba(200,90,90,0.12); border-color: #c85a5a; }
</style>
