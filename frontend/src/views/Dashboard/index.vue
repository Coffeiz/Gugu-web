<template>
  <div class="dashboard">
    <!-- 统计卡片 -->
    <div class="stats-row">
      <StatCard
        :label="t('dashboardUi.yearProjects')"
        :value="projectStore.totalCount"
        :sub-prefix="t('dashboardUi.thisYear')"
        :sub-text="t('dashboardUi.totalProjects')"
        subClass="up"
        glowColor="rgba(122,184,200,0.12)"
      />
      <StatCard
        :label="t('dashboardUi.inProgress')"
        :value="projectStore.activeCount"
        subPrefix="↑ 2"
        :sub-text="t('dashboardUi.vsLastMonth')"
        subClass="up"
        glowColor="rgba(123,127,178,0.14)"
      />
      <StatCard
        :label="t('dashboardUi.dueSoon')"
        :value="projectStore.upcomingCount"
        :sub-prefix="t('dashboardUi.withinDays', { count: 7 })"
        :sub-text="t('dashboardUi.dueProjects')"
        subClass="warn"
        glowColor="rgba(176,120,88,0.12)"
      />
      <StatCard
        :label="t('dashboardUi.totalFiles')"
        :value="fileCount"
        :sub-prefix="t('dashboardUi.thisAccount')"
        :sub-text="t('dashboardUi.totalFiles')"
        subClass="up"
        glowColor="rgba(196,175,200,0.12)"
      />
    </div>

    <!-- 中间行：项目列表 + 日历 -->
    <div class="mid-row">
      <ProjectList />
      <CalendarPanel />
    </div>

    <!-- 底部：文件 -->
    <FilePanel />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useProjectStore } from '@/stores/projects'
import { useFilesCacheStore } from '@/stores/filesCache'
import StatCard    from './components/StatCard.vue'
import ProjectList from './components/ProjectList.vue'
import CalendarPanel from './components/CalendarPanel.vue'
import FilePanel   from './components/FilePanel.vue'
import { useI18n } from 'vue-i18n'

const projectStore = useProjectStore()
const { t } = useI18n()
// 统一到全局 filesCache store（原来 Dashboard 单独走 services/cache 的第三套缓存）。store 自带
// 版本门控加载 + SSE + visibilitychange，FilePanel 与这里的文件总数都从它派生，单一数据源。
const store = useFilesCacheStore()
const fileCount = computed(() => store.loaded ? store.allFiles.length : '—')

onMounted(() => {
  if (!store.loaded && !store.loading) store.load()
})
</script>

<style scoped>
.dashboard {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-height: 100%;
}

.stats-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
  flex-shrink: 0;
}

.mid-row {
  display: grid;
  grid-template-columns: 1fr 340px;
  gap: 18px;
  flex: 1;
}

@media (max-width: 960px) {
  .stats-row { grid-template-columns: repeat(2, 1fr); }
  .mid-row   { grid-template-columns: 1fr; }
}
</style>
