<template>
  <div class="skills-page">
    <section class="skills-panel glass-card">
      <header class="skills-header">
        <SegmentedTabs
          :model-value="route.name === 'SkillsMcp' && mcpVisible ? 'mcp' : 'skills'"
          :tabs="skillTabs"
          :aria-label="t('skills.pageNavigation')"
          class="skills-nav"
          @update:model-value="switchSkillTab"
        />
        <ActionButton v-if="route.name === 'SkillsMcp'" fit class="skills-nav-action" @click="mcpCreateRequest++">
          <Icon name="action.add" :size="14" />{{ t('skillsMcpUi.add') }}
        </ActionButton>
        <ActionButton v-else fit class="skills-nav-action" @click="skillCreateRequest++">
          <Icon name="action.add" :size="14" />{{ t('skills.create') }}
        </ActionButton>
      </header>
      <SkillsHome
        v-show="route.name !== 'SkillsMcp'"
        :create-request="skillCreateRequest"
      />
      <McpServersView
        v-if="mcpVisible || route.name === 'SkillsMcp'"
        v-show="route.name === 'SkillsMcp'"
        :create-request="mcpCreateRequest"
      />
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import SegmentedTabs from '@/components/common/controls/SegmentedTabs.vue'
import Icon from '@/components/common/icons/Icon.vue'
import { mcpApi } from '@/services/api'
import { RESOURCE_REFRESH_EVENTS } from '@/services/resourceRefreshEvents'
import SkillsHome from './SkillsHome.vue'
import McpServersView from './McpServersView.vue'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const mcpCreateRequest = ref(0)
const skillCreateRequest = ref(0)
const mcpVisible = ref(false)

const SKILLS_TAB_KEY = 'gugu-skills-tab'
const skillTabs = computed(() => [
  { key: 'skills', label: t('skills.userSkills') },
  ...(mcpVisible.value ? [{ key: 'mcp', label: t('skills.mcp') }] : []),
])

async function refreshMcpVisibility() {
  try {
    const status = await mcpApi.status()
    mcpVisible.value = status.enabled
    if (!status.enabled && route.name === 'SkillsMcp') await router.replace('/skills')
  } catch {
    mcpVisible.value = false
  }
}

function switchSkillTab(key: string) {
  // 记住显式选择：页内点击 tab 是用户意图；外部导航回 /skills 时据此恢复。
  localStorage.setItem(SKILLS_TAB_KEY, key)
  void router.push(key === 'mcp' ? '/skills/mcp' : '/skills')
}

onMounted(async () => {
  await refreshMcpVisibility()
  const lastTab = localStorage.getItem(SKILLS_TAB_KEY)
  if (route.name === 'SkillsHome' && lastTab === 'mcp' && mcpVisible.value) {
    void router.replace('/skills/mcp')
  } else if (route.name === 'SkillsMcp') {
    localStorage.setItem(SKILLS_TAB_KEY, 'mcp')
  }
  window.addEventListener(RESOURCE_REFRESH_EVENTS.mcp, refreshMcpVisibility)
})
onBeforeUnmount(() => window.removeEventListener(RESOURCE_REFRESH_EVENTS.mcp, refreshMcpVisibility))
</script>

<style scoped>
.skills-page { height:100%; font-family:var(--font-sans); }
.skills-panel { --glass-card-background:var(--column-bg); --glass-card-background-hover:var(--column-bg); height:100%; box-sizing:border-box; display:flex; flex-direction:column; padding:22px 24px; }
.skills-header { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:16px; flex-shrink:0; }
.skills-nav-action { height:32px; min-height:32px; padding:7px 14px; border-radius:var(--radius-sm); }
</style>
