<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import Icon from '@/components/common/icons/Icon.vue'
import PageToolbar from '@/components/common/layout/PageToolbar.vue'
import ScrollableCardLayout from '@/components/common/layout/ScrollableCardLayout.vue'

const props = defineProps<{ section: 'terminals' | 'skills' | 'mcp' }>()
const { t } = useI18n()
const labels = computed(() => ({
  terminals: { name: '终端', icon: 'admin.terminal', action: '' },
  skills: { name: '技能', icon: 'resource.skill', action: t('skills.create') },
  mcp: { name: 'MCP', icon: 'resource.mcp', action: t('skillsMcpUi.add') },
}))
const current = computed(() => labels.value[props.section])
</script>

<template>
  <section class="desktop-resource" :aria-label="current.name">
    <PageToolbar v-if="section !== 'terminals'" class="desktop-page-toolbar" role="group" :aria-label="`${current.name}工具栏`">
      <ActionButton fit disabled><Icon name="action.add" :size="14" />{{ current.action }}</ActionButton>
    </PageToolbar>
    <div class="desktop-resource-content glass-card">
      <div v-if="section === 'terminals'" class="terminal-unavailable" role="status">桌面端暂不支持终端</div>
      <ScrollableCardLayout v-else>
        <div class="scrollable-card-layout__empty" role="status">
          <Icon :name="current.icon" :size="32" />
          <strong>桌面端暂不支持{{ current.name }}</strong>
          <span>{{ current.name }}服务接入后，可在这里管理。</span>
        </div>
      </ScrollableCardLayout>
    </div>
  </section>
</template>

<style scoped>
.desktop-resource { display: flex; flex-direction: column; gap: var(--space-md); height: 100%; }
.desktop-resource-content { display: flex; flex: 1; flex-direction: column; min-height: 0; padding: 0 var(--space-lg); }
.terminal-unavailable { display: grid; place-items: center; min-height: 180px; color: var(--content-tertiary); font-size: 12px; }
</style>
