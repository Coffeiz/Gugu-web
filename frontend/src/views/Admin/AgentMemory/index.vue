<template>
  <div class="agent-memory-page">
    <div class="page-header"><div class="page-title-block"><h2 class="page-title">Agent 记忆</h2><p class="page-desc">管理记忆维护与自动知识召回；关闭 RAG 后可进行无自动召回的对照测试。</p></div></div>
    <AdminSegmentTabs v-model="activeTab" :tabs="tabs" aria-label="Agent 记忆分类" class="memory-tabs" />
    <div class="panels-wrap">
      <template v-if="activeTab === 'maintenance'">
        <MemoryMaintenanceSettings />
        <MemoryMaintenancePanel />
      </template>
      <MemoryRecallPanel v-else />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import AdminSegmentTabs from '@/components/admin/AdminSegmentTabs.vue'
import MemoryMaintenancePanel from '../Agent/memory/components/MemoryMaintenancePanel.vue'
import MemoryRecallPanel from '../Agent/memory/components/MemoryRecallPanel.vue'
import MemoryMaintenanceSettings from '../Agent/memory/components/MemoryMaintenanceSettings.vue'
const activeTab = ref('maintenance')
const tabs = [{ key: 'maintenance', label: '记忆维护' }, { key: 'retrieval', label: '记忆召回' }]
</script>

<style scoped>
.agent-memory-page{min-height:100%;display:flex;flex-direction:column}.page-header{padding:32px 36px 0}.page-title{font-size:22px;font-weight:700;color:var(--content-primary);line-height:1}.page-desc{margin-top:6px;font-size:12px;color:var(--content-tertiary)}.memory-tabs{align-self:flex-start;margin:18px 36px 0}.panels-wrap{flex:1;padding:24px 36px 48px;width:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:14px}
</style>
