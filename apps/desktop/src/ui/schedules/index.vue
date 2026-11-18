<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import Icon from '@/components/common/icons/Icon.vue'
import PageToolbar from '@/components/common/layout/PageToolbar.vue'
import ScrollableCardLayout from '@/components/common/layout/ScrollableCardLayout.vue'

const { t } = useI18n()
</script>

<template>
  <section class="desktop-schedules" aria-label="定时任务">
    <PageToolbar class="desktop-page-toolbar" role="group" aria-label="定时任务工具栏">
      <ActionButton fit disabled>
        <Icon name="action.add" :size="14" />{{ t('schedules.create') }}
      </ActionButton>
    </PageToolbar>
    <ScrollableCardLayout class="desktop-schedules-content glass-card">
      <div class="scrollable-card-layout__empty">
        <Icon name="admin.alarm" :size="32" />
        <strong>桌面端暂不支持定时任务</strong>
        <span>定时任务服务接入后，可在这里管理任务。</span>
      </div>
    </ScrollableCardLayout>
  </section>
</template>

<style scoped>
.desktop-schedules {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  height: 100%;
}
.desktop-schedules-content {
  padding: 0 var(--space-lg);
}
</style>
