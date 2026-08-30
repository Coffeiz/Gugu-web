<template>
  <div class="agent-memory-page">
    <div class="page-header"><div class="page-title-block"><h2 class="page-title">{{ t('adminExtraUi.memoryTitle') }}</h2><p class="page-desc">{{ t('adminExtraUi.memoryDescription') }}</p></div></div>
    <AdminSegmentTabs v-model="activeTab" :tabs="tabs" :aria-label="t('adminExtraUi.memoryCategory')" class="memory-tabs" />
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
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AdminSegmentTabs from '@/components/admin/AdminSegmentTabs.vue'
import MemoryMaintenancePanel from '../Agent/memory/components/MemoryMaintenancePanel.vue'
import MemoryRecallPanel from '../Agent/memory/components/MemoryRecallPanel.vue'
import MemoryMaintenanceSettings from '../Agent/memory/components/MemoryMaintenanceSettings.vue'
const activeTab = ref('maintenance')
const { t } = useI18n()
const tabs = computed(() => [{ key: 'maintenance', label: t('adminExtraUi.maintenance') }, { key: 'retrieval', label: t('adminExtraUi.retrieval') }])
</script>

<style scoped>
.agent-memory-page{min-height:100%;display:flex;flex-direction:column}.page-header{padding:32px 36px 0}.page-title{font-size:22px;font-weight:700;color:var(--content-primary);line-height:1}.page-desc{margin-top:6px;font-size:12px;color:var(--content-tertiary)}.memory-tabs{align-self:flex-start;margin:18px 36px 0}.panels-wrap{flex:1;padding:24px 36px 48px;width:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:14px}
</style>
