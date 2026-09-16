<template>
  <div class="skills-page">
    <section class="skills-panel glass-card">
      <header class="skills-header">
        <SegmentedTabs
          :model-value="route.name === 'SkillsMcp' ? 'mcp' : 'skills'"
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
import { rememberSkillsTab } from './skillsTab'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const mcpCreateRequest = ref(0)
const skillCreateRequest = ref(0)
// 乐观种子：守卫放行 SkillsMcp 即代表 MCP 已启用，首帧就让 tab 存在——
// 否则 activeIndex 找不到目标回退 0，status 返回后胶囊从技能位滑过去。
const mcpVisible = ref(route.name === 'SkillsMcp')


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
  rememberSkillsTab(key === 'mcp' ? 'mcp' : 'skills')
  void router.push(key === 'mcp' ? '/skills/mcp' : '/skills')
}

onMounted(() => {
  // tab 恢复由路由守卫在挂载前完成（见 router/index.ts），这里只补记直连 /skills/mcp 的情况。
  if (route.name === 'SkillsMcp') rememberSkillsTab('mcp')
  void refreshMcpVisibility()
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
