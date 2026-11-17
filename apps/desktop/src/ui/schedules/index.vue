<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import Icon from '@/components/common/icons/Icon.vue'
import ScrollableCardLayout from '@/components/common/layout/ScrollableCardLayout.vue'

const { t } = useI18n()
</script>

<template>
  <section class="desktop-schedules glass-card" aria-label="定时任务">
    <ScrollableCardLayout>
      <template #actions>
        <ActionButton fit disabled>
          <Icon name="admin.alarm" :size="14" />{{ t('schedules.create') }}
        </ActionButton>
      </template>
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
  --glass-card-background: var(--column-bg);
  --glass-card-background-hover: var(--column-bg);
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  padding: 0 var(--space-lg);
}
</style>
