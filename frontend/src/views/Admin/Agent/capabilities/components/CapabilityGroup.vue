<template>
  <div class="capability-catalog-group">
    <h4>{{ title }}</h4>
    <div class="capability-catalog-grid">
      <div v-for="item in items" :key="item.name" class="capability-catalog-item">
        <div class="capability-catalog-item-head">
          <code>{{ item.name }}</code>
          <span>{{ item.category || '未分类' }}</span>
        </div>
        <p>{{ item.description_short }}</p>
        <small>{{ toolItems
          ? (item.permissions.length ? `权限：${item.permissions.join('、')}` : '无额外权限声明')
          : (item.related_tools.length ? `关联工具：${item.related_tools.join('、')}` : '未声明关联工具') }}</small>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { CapabilityCatalogItem } from '../useCapabilityCatalog'

defineProps<{
  title: string
  items: CapabilityCatalogItem[]
  toolItems?: boolean
}>()
</script>

<style scoped>
.capability-catalog-group { margin-top: 18px; }
.capability-catalog-group h4 { margin: 0 0 9px; color: rgba(255,255,255,0.48); font-size: 12px; font-weight: 600; }
.capability-catalog-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 12px; }
.capability-catalog-item { min-width: 0; padding: 10px 12px; border: 1px solid rgba(255,255,255,0.07); border-radius: 9px; background: rgba(255,255,255,0.025); }
.capability-catalog-item-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.capability-catalog-item code { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #d6d8ee; font-size: 11px; }
.capability-catalog-item-head span { flex: 0 0 auto; color: rgba(255,255,255,0.32); font-size: 10px; }
.capability-catalog-item p { margin: 6px 0 5px; color: rgba(255,255,255,0.68); font-size: 12px; line-height: 1.5; }
.capability-catalog-item small { display: block; overflow: hidden; color: rgba(255,255,255,0.32); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 720px) { .capability-catalog-grid { grid-template-columns: 1fr; } }
</style>
