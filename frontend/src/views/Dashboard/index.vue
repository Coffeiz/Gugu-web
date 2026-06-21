<template>
  <div class="dashboard">
    <!-- 统计卡片 -->
    <div class="stats-row">
      <StatCard
        label="年度项目"
        :value="projectStore.totalCount"
        subPrefix="本年度"
        subText="累计项目"
        subClass="up"
        glowColor="rgba(122,184,200,0.12)"
      />
      <StatCard
        label="进行中"
        :value="projectStore.activeCount"
        subPrefix="↑ 2"
        subText="较上月"
        subClass="up"
        glowColor="rgba(123,127,178,0.14)"
      />
      <StatCard
        label="即将到期"
        :value="projectStore.upcomingCount"
        subPrefix="7天内"
        subText="截止项目"
        subClass="warn"
        glowColor="rgba(176,120,88,0.12)"
      />
      <StatCard
        label="文件总数"
        :value="fileCount"
        subPrefix="本账户"
        subText="总文件数"
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

<script setup>
import { computed, onMounted } from 'vue'
import { useProjectStore } from '@/stores/projects'
import { filesApi } from '@/services/api'
import { filesCache, filesCacheVersion } from '@/services/cache'
import StatCard    from './components/StatCard.vue'
import ProjectList from './components/ProjectList.vue'
import CalendarPanel from './components/CalendarPanel.vue'
import FilePanel   from './components/FilePanel.vue'

const projectStore = useProjectStore()
const fileCount = computed(() => filesCache.ref.value?.length ?? '—')

onMounted(async () => {
  try {
    const { version: ver } = await filesApi.version()
    if (ver && ver === filesCacheVersion.get() && filesCache.data) return  // 数据未变，跳过全量拉取
    const fresh = await filesApi.list()
    filesCache.set(fresh)
    if (ver) filesCacheVersion.set(ver)
  } catch { /* ignore */ }
})
</script>

<style scoped>
.dashboard {
  display: flex;
  flex-direction: column;
  gap: 18px;
  height: 100%;
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
  grid-template-rows: 1fr;
  gap: 18px;
  flex: 1;
  min-height: 0;
}

@media (max-width: 960px) {
  .stats-row { grid-template-columns: repeat(2, 1fr); }
  .mid-row   { grid-template-columns: 1fr; }
}
</style>
