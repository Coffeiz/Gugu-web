<template>
  <div class="agent-page">

    <div class="page-header">
      <div class="page-title-block">
        <h2 class="page-title">{{ standaloneMode === 'behavior' ? t('agent.capabilityTitle') : standaloneMode === 'usage' ? t('agent.usageTitle') : t('agent.title') }}</h2>
        <p class="page-desc">{{ standaloneMode ? t('agent.standaloneDescription') : t('agent.description') }}</p>
      </div>
      <div v-if="standaloneMode === 'usage'" class="page-header-actions">
        <Checkbox class="data-header-control" :model-value="excludeDev" :aria-label="t('adminUsageUi.excludeDevelopers')" @update:model-value="excludeDev = $event">{{ t('adminUsageUi.excludeDevelopers') }}</Checkbox>
        <Checkbox class="data-header-control" :model-value="includeByok" :aria-label="t('adminUsageUi.includeByok')" @update:model-value="includeByok = $event">{{ t('adminUsageUi.includeByok') }}</Checkbox>
        <SegmentedTabs
          :model-value="usagePeriod"
          :tabs="usagePeriods"
          size="compact"
          class="data-header-control"
          :aria-label="t('adminUsageUi.timezone')"
          @update:model-value="setUsagePeriod"
        />
      </div>
    </div>

    <!-- 标签栏 -->
    <SegmentedTabs v-if="!standaloneMode" :model-value="activeTab" :tabs="tabs" :aria-label="t('agent.tabsLabel')" class="agent-tabs" @update:model-value="switchTab" />

    <SegmentedTabs v-if="activeTab === 'behavior'" v-model="behaviorTab" :tabs="behaviorTabs" :aria-label="t('agent.behaviorTabsLabel')" class="behavior-tabs" />

    <div class="panels-wrap">

      <!-- ── 权限开放 ── -->
      <PermissionSettings
        v-if="activeTab === 'permissions'"
        :agent="agentDraft"
        :byok="byokDraft"
        :sandbox-enabled="sandboxRuntimeEnabled"
        :saving="permissionSaving"
        :saved="permissionSaved"
        :error="permissionError"
        @save="savePermissions"
        @reset="resetPermissions"
      />

      <!-- ── 能力目录 ── -->
      <CapabilityCatalogPanel
        v-if="activeTab === 'behavior' && behaviorTab === 'capabilities'"
        :mcp-enabled="configStore.cfg.mcp.enabled"
        :mcp-saving="mcpSaving"
        :mcp-saved="mcpSaved"
        :mcp-error="mcpError"
        @toggle-mcp="saveMcpEnabled"
      />

      <!-- ── LLM 预设 ── -->
      <div v-if="activeTab === 'llm'">
        <!-- 标题行 -->
        <div class="presets-header">
          <div>
            <h3 class="presets-title">{{ t('agent.presetTitle') }}</h3>
            <p class="presets-desc">{{ t('agent.presetDescription') }}</p>
          </div>
          <div class="presets-header-right">
            <div class="strategy-select" :title="t('agentConfigUi.concurrencyHint')">
              <span>{{ t('agent.concurrency') }}</span>
              <input type="number" min="1" max="64" class="conc-input"
                     v-model.number="agentDraft.worker_concurrency" :aria-label="t('agent.concurrency')" @change="saveConcurrency" />
            </div>
            <div class="strategy-select">
              <span>{{ t('agent.strategy') }}</span>
              <AdminSelect
                :model-value="strategy"
                :options="[
                  { value: 'active', label: t('agent.active') },
                  { value: 'pool',   label: t('agent.pool') },
                  { value: 'router', label: t('agent.router') },
                ]"
                @update:model-value="setStrategy"
              />
            </div>
            <div v-if="strategy === 'pool'" class="strategy-select" :title="t('agentConfigUi.routingHint')">
              <span>{{ t('agent.routing') }}</span>
              <AdminSelect
                :model-value="poolMode"
                :options="[
                  { value: 'random',       label: t('agent.random') },
                  { value: 'round_robin',  label: t('agent.roundRobin') },
                  { value: 'least_loaded', label: t('agent.leastLoaded') },
                ]"
                @update:model-value="setPoolMode"
              />
            </div>
            <button class="btn-primary" @click="openNewPreset">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6.5 1v11M1 6.5h11"/></svg>
            {{ t('agent.createPreset') }}
            </button>
          </div>
        </div>

        <div v-if="presetsLoading" class="presets-loading">{{ t('agent.loading') }}</div>

        <div v-else class="preset-list">
          <div
            v-for="p in presets"
            :key="p.id"
            class="preset-card"
            :class="{ 'preset-card--active': p.id === activePresetId }"
          >
            <div class="preset-card-left">
              <span class="provider-dot" :class="`dot-${p.provider}`"></span>
            </div>
            <div class="preset-card-body">
              <div class="preset-card-top">
                <span class="preset-name">{{ p.name }}</span>
                <span v-if="p.id === activePresetId" class="active-badge">{{ t('agent.current') }}</span>
                <span class="provider-label">{{ p.provider }}</span>
              </div>
              <div class="preset-card-meta">
                <span class="preset-model">{{ p.model }}</span>
                <span class="preset-meta-item">out {{ p.max_tokens ?? 25600 }}</span>
                <span class="preset-meta-item">ctx {{ p.context_tokens ?? 128000 }}</span>
                                <span v-if="p.thinking === 'adaptive'" class="preset-meta-item preset-meta-think"><Icon name="admin.brain" size="xs" />{{ t('agent.thinking') }}</span>
                <span v-if="p.reasoning_persistence === 'continuation'" class="preset-meta-item">{{ t('llmExtraUi.reasoningContinuation') }}</span>
                <span v-if="p.image" class="preset-meta-item preset-meta-media"><Icon name="admin.eye" size="xs" />{{ t('agent.image') }}</span>
                <span v-if="p.video" class="preset-meta-item preset-meta-media"><Icon name="admin.video" size="xs" />{{ t('agent.video') }}</span>
                <span v-if="p.audio" class="preset-meta-item preset-meta-media"><Icon name="admin.microphone" size="xs" />{{ t('agent.audio') }}</span>
                <span class="preset-key" :title="typeof p.api_key === 'string' ? p.api_key : t('agent.unsetKey')">{{ typeof p.api_key === 'string' ? p.api_key : t('agent.unsetKey') }}</span>
              </div>
            </div>
            <div class="preset-card-actions">
              <button v-if="strategy === 'pool'" class="pca-btn" :class="{ 'pca-btn--pool-on': p.in_pool }" @click="togglePool(p)">
                {{ p.in_pool ? t('agent.pooling') : t('agent.joinPool') }}
              </button>
              <button class="pca-btn" @click="openEditPreset(p)">{{ t('agent.edit') }}</button>
              <button class="pca-btn" :class="{ 'pca-btn--testing': testingId === p.id }" @click="testPreset(p.id)">
                {{ testingId === p.id ? t('agent.testing') : t('agent.test') }}
              </button>
              <button class="pca-btn" :class="{ 'pca-btn--testing': probingId === p.id }" @click="probeMedia(p.id)">
                {{ probingId === p.id ? t('agent.probing') : t('agent.probe') }}
              </button>
              <button
                v-if="p.id !== activePresetId"
                class="pca-btn pca-btn--activate"
                :class="{ 'pca-btn--activating': activatingId === p.id }"
                @click="activatePreset(p.id)"
              >{{ activatingId === p.id ? t('agent.switching') : t('agent.setCurrent') }}</button>
              <button
                v-if="p.id !== activePresetId"
                class="pca-btn pca-btn--del"
                @click="deletePreset(p.id)"
              >{{ t('agent.delete') }}</button>
            </div>
          </div>
        </div>

        <div v-if="llmMsg && !editTarget" class="llm-msg" :class="{ 'llm-msg--error': llmMsgError }">
          <span v-if="!llmMsgParts.length" class="llm-msg__dot" :class="llmMsgError ? 'is-error' : 'is-success'" aria-hidden="true"></span>
          <template v-if="llmMsgParts.length">
            <template v-for="(part, index) in llmMsgParts" :key="part.key">
              <span class="llm-msg__part" :class="`is-${part.status}`"><span v-if="index" class="llm-msg__separator">｜</span><span class="llm-msg__dot" aria-hidden="true"></span>{{ part.label }}：{{ part.text }}</span>
            </template>
          </template>
          <template v-else>{{ llmMsg }}</template>
        </div>
      </div>

      <LlmPresetEditor
        v-if="editTarget"
        :draft="editTarget"
        :visible="!editClosing"
        :is-new="editIsNew"
        :saving="editSaving"
        :error="editError"
        :probe-feedback="editorFeedback"
        :providers="PROVIDERS"
        :image-detail-levels="IMAGE_DETAIL_LEVELS"
        :media-dimensions="mediaDimensions"
        :capability-loading="capabilityProbeLoading"
        :capability-results="capabilityProbeResult"
        :model-loading="modelListLoading"
        :model-error="modelListError"
        :model-menu-open="modelMenuOpen"
        :model-options="modelOptions"
        :probing-dim="probingDim"
        @close="closePresetEditor"
        @after-close="finishPresetClose"
        @save="savePreset"
        @set-provider="setEditProviderSelection"
        @open-model-menu="modelMenuOpen = true"
        @close-model-menu="modelMenuOpen = false"
        @fetch-model-list="fetchModelList"
        @select-model="selectModel"
        @pick-api-format="pickApiFormat"
        @set-capability-override="setCapabilityOverride"
        @probe-capabilities="probeCapabilities"
        @probe-media="probeMedia"
      />

      <!-- ── 系统提示词 ── -->
      <PromptPanel v-if="activeTab === 'prompts'" />

      <!-- ── 行为配置 ── -->
      <section v-if="activeTab === 'behavior' && behaviorTab === 'runtime'" class="config-card">
        <div class="card-head">
          <div class="card-icon" style="--ic:rgba(123,127,178,0.15);--stroke:#7b7fb2">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round">
              <path d="M10 2a8 8 0 100 16A8 8 0 0010 2z"/>
              <path d="M10 6v4l3 3"/>
            </svg>
          </div>
          <div class="card-title-block">
            <h3>{{ t('agent.runtimeTitle') }}</h3>
            <p>{{ t('agent.runtimeDescription') }}</p>
          </div>
        </div>

        <div class="behavior-grid">
          <ParallelToolExecutionControl
            :model-value="agentDraft.parallel_tool_execution_enabled"
            :max-concurrency="agentDraft.parallel_tool_max_concurrency"
            @update:model-value="agentDraft.parallel_tool_execution_enabled = $event; saveBehavior()"
            @update:max-concurrency="agentDraft.parallel_tool_max_concurrency = $event; saveBehavior()"
          />

          <div v-if="behaviorTab === 'runtime'" class="behavior-item">
            <div class="behavior-label">
              <span>{{ t('agent.conversationCompression') }}</span>
              <span class="behavior-desc">{{ t('adminRuntimeUi.compressionHint') }}</span>
            </div>
            <ToggleSwitch :model-value="agentDraft.conv_compress_enabled" :aria-label="t('adminRuntimeUi.toggleCompression')" @update:model-value="agentDraft.conv_compress_enabled = $event; saveBehavior()" />
          </div>

          <div v-if="behaviorTab === 'runtime'" class="behavior-item">
            <div class="behavior-label">
              <span>{{ t('adminRuntimeUi.greetingTitle') }}</span>
              <span class="behavior-desc">{{ t('adminRuntimeUi.greetingHint') }}</span>
            </div>
            <ToggleSwitch :model-value="agentDraft.greeting_enabled" :aria-label="t('adminRuntimeUi.toggleGreeting')" @update:model-value="agentDraft.greeting_enabled = $event; saveBehavior()" />
          </div>

          <div v-if="behaviorTab === 'runtime'" class="behavior-item">
            <div class="behavior-label">
                <span>{{ t('adminRuntimeUi.progressTitle') }}</span>
                <span class="behavior-desc">{{ t('adminRuntimeUi.progressHint') }}</span>
            </div>
            <ToggleSwitch :model-value="agentDraft.im_progress_announce_enabled" :aria-label="t('adminRuntimeUi.toggleProgress')" @update:model-value="agentDraft.im_progress_announce_enabled = $event; saveBehavior()" />
          </div>

        </div>

        <div class="card-actions">
          <span class="save-hint" :class="{ error: !!behaviorError }">
            <template v-if="behaviorSaved"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 6l2.5 2.5 5.5-5"/></svg>{{ t('agent.saved') }}</template>
            <template v-else-if="behaviorError">{{ behaviorError }}</template>
          </span>
          <button class="btn-ghost" @click="resetBehavior">{{ t('agent.reset') }}</button>
          <button class="btn-primary" :class="{ loading: behaviorSaving }" :disabled="behaviorSaving" @click="saveBehavior">
            <svg v-if="behaviorSaving" class="spin-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 1v2M6 9v2M1 6h2M9 6h2"/></svg>
            {{ behaviorSaving ? t('agent.saving') : t('agent.save') }}
          </button>
        </div>
      </section>

      <!-- ── 联网搜索（Tavily）── -->
      <section v-if="activeTab === 'behavior' && behaviorTab === 'search'" class="config-card">
        <div class="card-head">
          <div class="card-icon" style="--ic:rgba(122,184,200,0.15);--stroke:#7ab8c8">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round">
              <circle cx="9" cy="9" r="6"/>
              <path d="M17 17l-3.5-3.5"/>
            </svg>
          </div>
          <div class="card-title-block">
            <h3>{{ t('agent.searchTitle') }}</h3>
            <p>{{ t('agentConfigUi.searchHint') }}</p>
          </div>
        </div>

        <div class="behavior-grid">
          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label">
              <span>{{ t('agentConfigUi.searchAddress') }}</span>
              <span class="behavior-desc">{{ t('agentConfigUi.searchAddressHint') }}</span>
            </div>
            <div style="display:flex; align-items:center; gap:10px; justify-content:flex-end; min-width:0;">
              <span v-if="searchTest.searxng.msg" :title="searchTest.searxng.msg"
                    :style="{ color: searchTest.searxng.ok ? '#4caf7d' : '#e07070', fontSize:'12px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', minWidth:0 }">
                {{ searchTest.searxng.msg }}
              </span>
              <button class="btn-ghost" style="flex-shrink:0;" :disabled="searchTest.searxng.loading" @click="testSearch('searxng')">
                {{ searchTest.searxng.loading ? t('agentConfigUi.testing') : t('agentConfigUi.test') }}
              </button>
              <input
                type="text"
                class="behavior-input"
                style="width: 280px; flex-shrink:0;"
                v-model="generalSearchDraft.searxng_url"
                :placeholder="t('agentConfigUi.searchUrlPlaceholder')"
              />
            </div>
          </div>

          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label">
              <span>{{ t('agentConfigUi.searchEngine') }}</span>
              <span class="behavior-desc">{{ t('agentConfigUi.searchEngineHint') }}</span>
            </div>
            <input
              type="text"
              class="behavior-input"
              style="width: 280px;"
              v-model="generalSearchDraft.searxng_engines"
              placeholder="baidu,sogou,quark,360search,yandex,duckduckgo web,mwmbl,gabanza,reloado,searchch,privacywall,gmx,zapmeta,google"
            />
          </div>

          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label">
              <span>{{ t('agentConfigUi.imageEngine') }}</span>
              <span class="behavior-desc">{{ t('agentConfigUi.imageEngineHint') }}</span>
            </div>
            <div style="display:flex; align-items:center; gap:10px; justify-content:flex-end; min-width:0;">
              <span v-if="searchTest.searxng_images.msg" :title="searchTest.searxng_images.msg"
                    :style="{ color: searchTest.searxng_images.ok ? '#4caf7d' : '#e07070', fontSize:'12px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', minWidth:0 }">
                {{ searchTest.searxng_images.msg }}
              </span>
              <button class="btn-ghost" style="flex-shrink:0;" :disabled="searchTest.searxng_images.loading" @click="testSearch('searxng_images')">
                {{ searchTest.searxng_images.loading ? t('agentConfigUi.testing') : t('agentConfigUi.test') }}
              </button>
              <input
                type="text"
                class="behavior-input"
                style="width: 280px; flex-shrink:0;"
                v-model="generalSearchDraft.searxng_image_engines"
              :placeholder="t('agentConfigUi.imageEnginePlaceholder')"
              />
            </div>
          </div>

          <div class="behavior-item">
            <div class="behavior-label">
              <span>{{ t('agentConfigUi.defaultResults') }}</span>
              <span class="behavior-desc">{{ t('agentConfigUi.defaultResultsHint') }}</span>
            </div>
            <input
              type="number"
              class="behavior-input number-input"
              v-model.number="generalSearchDraft.max_results"
              min="1" max="20"
            />
          </div>

        </div>

        <div class="card-actions">
          <span class="save-hint" :class="{ error: !!generalSearchError }">
            <template v-if="generalSearchSaved"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 6l2.5 2.5 5.5-5"/></svg>{{ t('agent.saved') }}</template>
            <template v-else-if="generalSearchError">{{ generalSearchError }}</template>
          </span>
          <button class="btn-ghost" @click="resetGeneralSearch">{{ t('agentConfigUi.undo') }}</button>
          <button class="btn-primary" :class="{ loading: generalSearchSaving }" :disabled="generalSearchSaving" @click="saveSearch('general')">
            <svg v-if="generalSearchSaving" class="spin-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 1v2M6 9v2M1 6h2M9 6h2"/></svg>
            {{ generalSearchSaving ? t('agent.saving') : t('agent.save') }}
          </button>
        </div>
      </section>

      <DeepResearchConfig
        v-if="activeTab === 'behavior' && behaviorTab === 'search'"
        :draft="deepResearchDraft"
        :test="deepResearchTest"
        :saving="deepResearchSaving"
        :saved="deepResearchSaved"
        :error="deepResearchError"
        @test="testDeepResearch"
        @reset="resetDeepResearch"
        @save="saveDeepResearch"
      />

      <SimilarImageConfig
        v-if="activeTab === 'behavior' && behaviorTab === 'search'"
        :draft="similarImageDraft"
        :test="searchTest.baidu_similar_images"
        :saving="similarImageSaving"
        :saved="similarImageSaved"
        :error="similarImageError"
        @test="testSearch('baidu_similar_images')"
        @reset="resetSimilarImageSearch"
        @save="saveSearch('similar')"
      />

      <VoiceModelConfig
        v-if="activeTab === 'voice'"
      />

      <!-- ── 状态命名 ── -->
      <StateLabelsPanel v-if="activeTab === 'behavior' && behaviorTab === 'labels'" />

      <!-- ── 用量统计 ── -->
      <UsagePanel v-if="activeTab === 'usage'" :period="usagePeriod" :exclude-dev="excludeDev" :include-byok="includeByok" />

    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import ToggleSwitch from '@/components/common/controls/ToggleSwitch.vue'
import { useRoute } from 'vue-router'
import PermissionSettings from './components/PermissionSettings.vue'
import CapabilityCatalogPanel from './capabilities/components/CapabilityCatalogPanel.vue'
import UsagePanel from './observability/components/UsagePanel.vue'
import PromptPanel from './prompting/components/PromptPanel.vue'
import StateLabelsPanel from './prompting/components/StateLabelsPanel.vue'
import { useAgentRuntimeConfig } from './runtime-config/useAgentRuntimeConfig'
import { useLlmPresets, type LlmMessagePart } from './llm/useLlmPresets'
import AdminSelect from '@/components/AdminSelect.vue'
import { useConfigStore } from '@/stores/config'
import { useAdminStore } from '@/stores/admin'
import SegmentedTabs from '@/components/common/controls/SegmentedTabs.vue'
import Checkbox from '@/components/common/controls/Checkbox.vue'
import LlmPresetEditor from './llm/components/LlmPresetEditor.vue'
import DeepResearchConfig from './runtime-config/components/DeepResearchConfig.vue'
import ParallelToolExecutionControl from './runtime-config/components/ParallelToolExecutionControl.vue'
import SimilarImageConfig from './runtime-config/components/SimilarImageConfig.vue'
import { useMultimodalProbe } from './llm/useMultimodalProbe'
import VoiceModelConfig from './runtime-config/components/VoiceModelConfig.vue'
import { useI18n } from 'vue-i18n'
import { MODEL_PROVIDERS } from '@/utils/modelProviders'
import { RESOURCE_REFRESH_EVENTS } from '@/services/resourceRefreshEvents'
import { excludeDev, includeByok } from '../Analytics/_shared'

const configStore = useConfigStore()
const adminStore  = useAdminStore()
const route = useRoute()
const { t } = useI18n()
const standaloneMode = computed(() => route.path === '/agent-behavior' ? 'behavior' : route.path === '/agent-usage' ? 'usage' : '')
type UsagePeriod = 'day' | 'week' | 'month'
const usagePeriod = ref<UsagePeriod>('day')
const usagePeriods = computed(() => [
  { key: 'day', label: t('adminUsageUi.today') },
  { key: 'week', label: t('adminUsageUi.recent7') },
  { key: 'month', label: t('adminUsageUi.recent30') },
])
function setUsagePeriod(value: string) {
  if (value === 'day' || value === 'week' || value === 'month') {
    usagePeriod.value = value
  }
}
const runtimeConfig = useAgentRuntimeConfig()
const { agentDraft, behaviorSaving, behaviorSaved, behaviorError, resetBehavior, saveBehavior, generalSearchDraft, deepResearchDraft, similarImageDraft, generalSearchSaving, generalSearchSaved, generalSearchError, deepResearchSaving, deepResearchSaved, deepResearchError, deepResearchTest, similarImageSaving, similarImageSaved, similarImageError, resetGeneralSearch, resetDeepResearch, resetSimilarImageSearch, searchTest, testSearch, testDeepResearch, saveDeepResearch, saveSearch } = runtimeConfig
const llmPresets = useLlmPresets(adminStore, configStore, agentDraft)
const { presets, activePresetId, strategy, poolMode, presetsLoading, llmMsg, llmMsgParts, llmMsgError, testingId, activatingId, probingId, probingDim, showMsg, showMsgParts, fetchPresets, setStrategy, setPoolMode, saveConcurrency, activatePreset, deletePreset, testPreset } = llmPresets
const byokDraft = reactive({ ...configStore.cfg.byok })
const permissionSaving = ref(false)
const permissionSaved = ref(false)
const permissionError = ref('')
const sandboxRuntimeEnabled = ref(false)
const mcpSaving = ref(false)
const mcpSaved = ref(false)
const mcpError = ref('')
const tabs = computed(() => [
  { key: 'llm',      label: t('agent.llm') },
  { key: 'voice',    label: t('admin.voiceModel') },
  { key: 'permissions', label: t('agent.permissions') },
  { key: 'prompts',  label: t('agent.prompts') },
])
const activeTab = ref(standaloneMode.value || 'llm')
const behaviorTabs = computed(() => [
  { key: 'runtime', label: t('agent.runtime') },
  { key: 'search', label: t('agent.search') },
  { key: 'capabilities', label: t('agent.capabilities') },
  { key: 'labels', label: t('agent.labels') },
])
const behaviorTab = ref('runtime')

function switchTab(key: string) {
  activeTab.value = key
  if (key === 'llm'     && presets.value.length === 0) fetchPresets()
}

async function saveMcpEnabled(enabled: boolean) {
  mcpSaving.value = true
  mcpSaved.value = false
  mcpError.value = ''
  await configStore.saveConfig({ mcp: { enabled } })
  if (configStore.saveError) {
    mcpError.value = configStore.saveError
  } else {
    mcpSaved.value = true
    window.dispatchEvent(new Event(RESOURCE_REFRESH_EVENTS.mcp))
    setTimeout(() => { mcpSaved.value = false }, 3000)
  }
  mcpSaving.value = false
}

// ── LLM 预设 ──────────────────────────────────────────────────────────────
const PROVIDERS = computed(() => [
  ...MODEL_PROVIDERS.map(provider => ({ key: provider.value, label: t(provider.labelKey), base_url: provider.base_url, model: provider.model })),
])

const capabilityProbeLoading = ref(false)
const capabilityProbeResult = ref<Record<string, { status?: string; detail?: string }>>({})

// 多模态三维度：image、video、audio
const mediaDimensions = computed(() => [
  { key: 'image', label: t('agent.image'), hint: t('adminAgentUi.imageHint') },
  { key: 'video', label: t('agent.video'), hint: t('adminAgentUi.videoHint') },
  { key: 'audio', label: t('agent.audio'), hint: t('adminAgentUi.audioHint') },
])
const IMAGE_DETAIL_LEVELS = computed(() => [
  { key: 'auto', label: t('adminAgentUi.auto') },
  { key: 'low', label: t('adminAgentUi.low') },
  { key: 'high', label: t('adminAgentUi.high') },
  { key: 'original', label: t('adminAgentUi.original') },
])

// edit modal
interface LlmPresetRecord {
  id: string | number
  name: string
  provider: string
  model: string
  in_pool?: boolean
  capability_probe?: Record<string, { status?: string; detail?: string }>
  capability_checked_at?: string
  capability_fingerprint?: string
  capability_overrides?: Record<string, boolean>
  [key: string]: unknown
}
interface LlmPresetDraft extends Partial<LlmPresetRecord> {
  name: string
  provider: string
  api_key: string
  base_url: string
  model: string
  max_tokens: number
  context_tokens: number
  thinking: string
  reasoning_persistence: 'off' | 'continuation'
  web_search_enabled: boolean
  image: boolean
  video: boolean
  audio: boolean
  capability_overrides: Record<string, boolean>
}
const editTarget   = ref<LlmPresetDraft | null>(null)
const editClosing  = ref(false)
const editIsNew    = ref(false)
const editSaving   = ref(false)
const editError    = ref('')
const modelOptions = ref<string[]>([])
const modelListLoading = ref(false)
const modelListError = ref('')
const modelMenuOpen = ref(false)



async function togglePool(p: LlmPresetRecord) {
  const next = !p.in_pool
  try {
    const res = await adminStore.authFetch(`/api/v1/admin/agent/llm-presets/${p.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ in_pool: next }),
    })
    if (!res.ok) throw new Error(t('adminAgentUi.operationFailed'))
    p.in_pool = next
  } catch (e) {
    showMsg(t('adminAgentUi.routingFailed', { message: e instanceof Error ? e.message : String(e) }), true)
  }
}

function openNewPreset() {
  editClosing.value = false
  editIsNew.value  = true
  editTarget.value = { name: '', provider: 'openai', api_key: '', base_url: PROVIDERS.value[0].base_url, model: PROVIDERS.value[0].model, max_tokens: 25600, context_tokens: 128000, thinking: '', reasoning_effort: '', reasoning_persistence: 'off', web_search_enabled: false, image: false, image_detail: 'auto', video: false, audio: false, api_format: '', ollama_mode: 'local', ollama_api_mode: 'native', ollama_keep_alive: '5m', deployment_mode: 'cloud', local_runtime: 'other', capability_overrides: {} }
  editError.value  = ''
  modelOptions.value = []
  modelListError.value = ''
  modelMenuOpen.value = false
  capabilityProbeResult.value = {}
}

function openEditPreset(p: LlmPresetRecord) {
  editClosing.value = false
  editIsNew.value  = false
  editTarget.value = { ...p, api_key: '', max_tokens: p.max_tokens ?? 25600, context_tokens: p.context_tokens ?? 128000, reasoning_persistence: p.reasoning_persistence === 'continuation' ? 'continuation' : 'off', web_search_enabled: Boolean(p.web_search_enabled), image_detail: p.image_detail || 'auto', ollama_mode: p.ollama_mode || 'local', ollama_api_mode: p.ollama_api_mode || 'native', ollama_keep_alive: p.ollama_keep_alive || '5m', deployment_mode: p.deployment_mode || (p.provider === 'local' ? 'local' : 'cloud'), local_runtime: p.local_runtime || 'other', capability_overrides: p.capability_overrides || {} } as unknown as LlmPresetDraft
  editError.value  = ''
  modelOptions.value = []
  modelListError.value = ''
  modelMenuOpen.value = false
  capabilityProbeResult.value = p.capability_probe || {}
}

function closePresetEditor() {
  editClosing.value = true
}

function finishPresetClose() {
  if (!editClosing.value) return
  editTarget.value = null
  editClosing.value = false
  modelMenuOpen.value = false
}

function setCapabilityOverride(key: string, enabled: boolean) {
  if (!editTarget.value) return
  const next = { ...(editTarget.value.capability_overrides || {}) }
  if (enabled) next[key] = true
  else delete next[key]
  editTarget.value.capability_overrides = next
}

async function probeCapabilities(id: string) {
  const target = editTarget.value
  if (!id || capabilityProbeLoading.value || !target) return
  capabilityProbeLoading.value = true
  try {
    const res = await adminStore.authFetch(`/api/v1/admin/agent/llm-presets/${id}/capabilities`, { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.detail || t('adminAgentUi.capabilityProbeFailed'))
    target.capability_checked_at = data.checked_at || ''
    target.capability_fingerprint = data.fingerprint || ''
    capabilityProbeResult.value = data.results || {}
    const mappings = [
      ['tools', 'tools'],
      ['structured_json', 'json_object'],
      ['structured_schema', 'json_schema'],
      ['thinking', 'reasoning'],
    ] as const
    const next = { ...(target.capability_overrides || {}) }
    for (const [capability, resultKey] of mappings) {
      const status = capabilityProbeResult.value[resultKey]?.status
      if (status === '支持') next[capability] = true
      else if (status === '需服务端配置') next[capability] = false
    }
    target.capability_overrides = next
  } catch (e) {
    editError.value = e instanceof Error ? e.message : t('adminAgentUi.capabilityProbeFailed')
  } finally {
    capabilityProbeLoading.value = false
  }
}

function selectModel(model: string) {
  if (!editTarget.value) return
  editTarget.value.model = model
  modelMenuOpen.value = false
}

async function fetchModelList() {
  const target = editTarget.value
  if (!target || modelListLoading.value) return
  modelListLoading.value = true
  modelListError.value = ''
  modelMenuOpen.value = true
  try {
    let res
    if (editIsNew.value || target.api_key.trim()) {
      // 新建，或编辑时刚填写了尚未保存的 Key：都使用表单里的临时配置，
      // 避免为了测试鉴权先把密钥持久化。
      res = await adminStore.authFetch('/api/v1/admin/agent/llm-presets/models-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: target.provider,
          base_url: target.base_url,
          api_key: target.api_key,
          api_format: target.api_format || '',
          local_runtime: target.local_runtime || 'other',
        }),
      })
    } else {
      res = await adminStore.authFetch(`/api/v1/admin/agent/llm-presets/${target.id}/models`)
    }
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.detail || t('adminAgentUi.modelsLoadFailed'))
    modelOptions.value = Array.isArray(data.models) ? data.models : []
    if (!modelOptions.value.length) modelListError.value = t('adminAgentUi.modelsEmpty')
  } catch (error) {
    modelOptions.value = []
    modelListError.value = error instanceof Error ? error.message : t('adminAgentUi.modelsLoadFailed')
  } finally {
    modelListLoading.value = false
  }
}

function setEditProvider(key: string) {
  const target = editTarget.value
  const pv = PROVIDERS.value.find(p => p.key === key)
  if (!pv || !target) return
  target.provider = key
  target.base_url = ''
  target.model    = pv.model
  // mimo 同时提供两套 API：默认 openai 格式；切到别的 provider 清掉（走自动判定）
  target.api_format = key === 'mimo' ? 'openai' : ''
  target.deployment_mode = key === 'local' ? 'local' : 'cloud'
  target.ollama_mode = key === 'ollama' ? 'local' : (target.ollama_mode || 'local')
  if (key === 'ollama') {
    target.ollama_api_mode = 'native'
    target.ollama_keep_alive = target.ollama_keep_alive || '5m'
  }
  modelOptions.value = []
  modelListError.value = ''
}

function setEditProviderSelection(selection: string) {
  const [provider, variant] = selection.split('|')
  setEditProvider(provider)
  const target = editTarget.value
  if (!target || !variant) return
  if (provider === 'glm') {
    target.provider = variant === 'coding' ? 'glm-coding' : 'glm'
    target.base_url = ''
  } else if (provider === 'local') {
    target.local_runtime = variant
    target.base_url = ''
  } else if (provider === 'ollama' && (variant === 'local' || variant === 'cloud')) {
    setOllamaMode(variant)
  }
}

function setOllamaMode(mode: 'local' | 'cloud') {
  if (!editTarget.value || editTarget.value.provider !== 'ollama') return
  editTarget.value.ollama_mode = mode
  editTarget.value.base_url = ''
  if (mode === 'local') editTarget.value.api_key = ''
  modelOptions.value = []
  modelListError.value = ''
}

// 协议对应的默认端点由 Provider 能力快照提供；手填的自定义 URL 保持不变。
function pickApiFormat(fmt: string) {
  const target = editTarget.value
  if (!target) return
  if (target.provider === 'glm' && (target.base_url || '').includes('/api/coding/')) target.provider = 'glm-coding'
  target.api_format = fmt
  modelOptions.value = []
  modelListError.value = ''
}

async function savePreset() {
  const target = editTarget.value
  if (!target) return
  editSaving.value = true
  editError.value  = ''
  try {
    const body = { ...target }
    let res
    if (editIsNew.value) {
      res = await adminStore.authFetch('/api/v1/admin/agent/llm-presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } else {
      res = await adminStore.authFetch(`/api/v1/admin/agent/llm-presets/${body.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.detail || t('adminAgentUi.saveFailedStatus', { status: res.status }))
    }
    editClosing.value = true
    await fetchPresets()
    showMsg(t('adminAgentUi.saved'))
  } catch (e) {
    editError.value = (e instanceof Error ? e.message : String(e))
  } finally {
    editSaving.value = false
  }
}


const { editorFeedback, probeMedia } = useMultimodalProbe({
  authFetch: adminStore.authFetch,
  target: () => editClosing.value ? null : editTarget.value,
  presets: () => presets.value,
  dimensions: () => mediaDimensions.value,
  probingId, probingDim, showMsg, showMsgParts,
})

onMounted(async () => {
  await configStore.fetchConfig()
  const sandboxResponse = await adminStore.authFetch('/api/v1/admin/sandbox/status')
  if (sandboxResponse.ok) {
    const sandboxStatus = await sandboxResponse.json()
    sandboxRuntimeEnabled.value = sandboxStatus.enabled === true && sandboxStatus.executor_ready === true
  }
  Object.assign(agentDraft, configStore.cfg.agent)
  Object.assign(byokDraft, configStore.cfg.byok)
  resetGeneralSearch()
  resetSimilarImageSearch()
  fetchPresets()
})


async function savePermissions() {
  permissionSaving.value = true
  permissionSaved.value = false
  permissionError.value = ''
  try {
    await configStore.saveConfig({ agent: { ...agentDraft }, byok: { ...byokDraft } })
    permissionSaved.value = true
    setTimeout(() => { permissionSaved.value = false }, 3000)
  } catch (error) {
    permissionError.value = error instanceof Error ? error.message : String(error)
  } finally {
    permissionSaving.value = false
  }
}

function resetPermissions() {
  Object.assign(agentDraft, configStore.cfg.agent)
  Object.assign(byokDraft, configStore.cfg.byok)
  permissionSaved.value = false
  permissionError.value = ''
}

</script>

<style scoped>
.agent-page { min-height: 100%; display: flex; flex-direction: column; }

.page-header {
  padding: 32px 36px 0;
  flex-shrink: 0;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}
.page-header-actions { display: flex; align-items: center; gap: 10px; min-height: 32px; margin-top: 4px; }
.page-header-actions > .data-header-control { height: 32px; box-sizing: border-box; }
.page-title { font-size: 22px; font-weight: 700; color: rgba(255,255,255,0.92); line-height: 1; }
.page-desc  { font-size: 12px; color: rgba(255,255,255,0.35); margin-top: 6px; }

/* ── 标签栏 ── */
.agent-tabs, .behavior-tabs {
  align-self: flex-start;
  margin: 18px 36px 0;
}

/* ── 面板区 ── */
.panels-wrap {
  flex: 1;
  padding: 14px 36px 32px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.config-card {
  background: rgba(255,255,255,0.05);
  backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(255,255,255,0.09); border-radius: 16px;
  padding: 22px 24px;
  box-shadow: 0 4px 24px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.06);
}

.card-head {
  display: flex; align-items: center; gap: 13px; margin-bottom: 20px;
}
.card-icon {
  width: 38px; height: 38px; border-radius: 11px; background: var(--ic);
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.card-icon svg { width: 18px; height: 18px; color: var(--stroke); }
.card-title-block { flex: 1; }
.card-title-block h3 { font-size: 14px; font-weight: 700; color: rgba(255,255,255,0.88); }
.card-title-block p  { font-size: 12px; color: rgba(255,255,255,0.38); margin-top: 2px; }
/* ── 操作栏 ── */
.card-actions {
  display: flex; align-items: center; gap: 10px;
  margin-top: 0; padding-top: 14px;
  border-top: 1px solid var(--panel-divider);
}
.card-actions > .btn-ghost,
.card-actions > .btn-primary { min-height: 34px; box-sizing: border-box; }
.save-hint {
  flex: 1; font-size: 12px; color: #5ab899;
  display: flex; align-items: center; gap: 5px;
}
.save-hint.muted { color: rgba(255,255,255,0.28); }
.save-hint.error { color: #e07878; }

/* ── 行为配置 ── */
.behavior-grid {
  display: flex; flex-direction: column; gap: 2px;
}
.behavior-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 0;
  border-bottom: 1px solid var(--panel-divider);
}
.behavior-item:last-child { border-bottom: none; }
.behavior-label { display: flex; flex-direction: column; gap: 3px; }
.behavior-label span:first-child { font-size: 13px; font-weight: 500; color: rgba(255,255,255,0.8); }
.behavior-desc { font-size: 12px; color: rgba(255,255,255,0.3); }

.behavior-input {
  width: 72px;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 13px; font-weight: 600;
  text-align: center; outline: none;
}


@keyframes spin { to { transform: rotate(360deg); } }
.spin-icon { animation: spin 0.8s linear infinite; }

</style>

<style scoped src="./components/model-presets.css"></style>
