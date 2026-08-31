<template>
  <div class="agent-page">

    <div class="page-header">
      <div class="page-title-block">
        <h2 class="page-title">{{ standaloneMode === 'behavior' ? t('agent.capabilityTitle') : standaloneMode === 'usage' ? t('agent.usageTitle') : t('agent.title') }}</h2>
        <p class="page-desc">{{ standaloneMode ? t('agent.standaloneDescription') : t('agent.description') }}</p>
      </div>
    </div>

    <!-- 标签栏 -->
    <AdminSegmentTabs v-if="!standaloneMode" :model-value="activeTab" :tabs="tabs" :aria-label="t('agent.tabsLabel')" class="agent-tabs" @update:model-value="switchTab" />

    <AdminSegmentTabs v-if="activeTab === 'behavior'" v-model="behaviorTab" :tabs="behaviorTabs" :aria-label="t('agent.behaviorTabsLabel')" class="behavior-tabs" />

    <div class="panels-wrap">

      <!-- ── 权限开放 ── -->
      <PermissionSettings
        v-if="activeTab === 'permissions'"
        :agent="agentDraft"
        :byok="byokDraft"
        :sandbox-enabled="configStore.cfg.sandbox.enabled === true"
        :saving="permissionSaving"
        :saved="permissionSaved"
        :error="permissionError"
        @save="savePermissions"
        @reset="resetPermissions"
      />

      <!-- ── 能力目录 ── -->
      <CapabilityCatalogPanel v-if="activeTab === 'behavior' && behaviorTab === 'capabilities'" />

      <!-- ── LLM 预设 ── -->
      <div v-if="activeTab === 'llm'">
        <!-- 标题行 -->
        <div class="presets-header">
          <div>
            <h3 class="presets-title">{{ t('agent.presetTitle') }}</h3>
            <p class="presets-desc">{{ t('agent.presetDescription') }}</p>
          </div>
          <div class="presets-header-right">
            <label class="strategy-select" :title="t('agentConfigUi.concurrencyHint')">
              <span>{{ t('agent.concurrency') }}</span>
              <input type="number" min="1" max="64" class="conc-input"
                     v-model.number="agentDraft.worker_concurrency" @change="saveConcurrency" />
            </label>
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
                <span class="preset-meta-item">out {{ p.max_tokens ?? 8000 }}</span>
                <span class="preset-meta-item">ctx {{ p.context_tokens ?? 128000 }}</span>
                <span class="preset-meta-item">temp {{ p.temperature ?? 0.7 }}</span>
                <span v-if="p.thinking === 'adaptive'" class="preset-meta-item preset-meta-think"><Icon name="admin.brain" size="xs" />{{ t('agent.thinking') }}</span>
                <span v-if="p.vision" class="preset-meta-item preset-meta-vision"><Icon name="admin.eye" size="xs" />{{ t('agent.image') }}</span>
                <span v-if="p.vision_video" class="preset-meta-item preset-meta-vision"><Icon name="admin.video" size="xs" />{{ t('agent.video') }}</span>
                <span v-if="p.vision_audio" class="preset-meta-item preset-meta-vision"><Icon name="admin.microphone" size="xs" />{{ t('agent.audio') }}</span>
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
              <button class="pca-btn" :class="{ 'pca-btn--testing': probingId === p.id }" @click="probeVision(p.id)">
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

        <div v-if="llmMsg" class="llm-msg" :class="{ 'llm-msg--error': llmMsgError }"><RiCheckFill v-if="llmMsgSuccess" class="llm-msg__icon" aria-hidden="true" />{{ llmMsg }}</div>
      </div>

      <LlmPresetEditor
        v-if="editTarget"
        :draft="editTarget"
        :visible="!editClosing"
        :is-new="editIsNew"
        :saving="editSaving"
        :error="editError"
        :providers="PROVIDERS"
        :api-formats="API_FORMATS"
        :deepseek-efforts="DEEPSEEK_EFFORTS"
        :image-detail-levels="IMAGE_DETAIL_LEVELS"
        :vision-dims="visionDims"
        :capability-loading="capabilityProbeLoading"
        :capability-results="capabilityProbeResult"
        :model-loading="modelListLoading"
        :model-error="modelListError"
        :model-menu-open="modelMenuOpen"
        :model-options="modelOptions"
        :filtered-models="filteredModelOptions"
        :probing-dim="probingDim"
        @close="closePresetEditor"
        @after-close="finishPresetClose"
        @save="savePreset"
        @set-provider="setEditProviderSelection"
        @open-model-menu="modelMenuOpen = true"
        @close-model-menu="closeModelMenuSoon"
        @fetch-model-list="fetchModelList"
        @select-model="selectModel"
        @pick-api-format="pickApiFormat"
        @set-capability-override="setCapabilityOverride"
        @probe-capabilities="probeCapabilities"
        @probe-vision="probeVision"
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
          <div v-if="behaviorTab === 'runtime'" class="behavior-item">
            <div class="behavior-label">
              <span>{{ t('agent.conversationCompression') }}</span>
              <span class="behavior-desc">{{ t('adminRuntimeUi.compressionHint') }}</span>
            </div>
            <ToggleSwitch :model-value="agentDraft.conv_compress_enabled" :aria-label="t('adminRuntimeUi.toggleCompression')" @update:model-value="agentDraft.conv_compress_enabled = $event; saveBehavior()" />
          </div>

          <div v-if="behaviorTab === 'runtime'" class="behavior-item">
            <div class="behavior-label">
                <span>{{ t('adminRuntimeUi.progressTitle') }}</span>
                <span class="behavior-desc">{{ t('adminRuntimeUi.progressHint') }}</span>
            </div>
            <ToggleSwitch :model-value="agentDraft.im_progress_announce_enabled" :aria-label="t('adminRuntimeUi.toggleProgress')" @update:model-value="agentDraft.im_progress_announce_enabled = $event; saveBehavior()" />
          </div>

          <div v-if="false" class="behavior-item">
            <div class="behavior-label">
              <span>Reflection 触发阈值</span>
              <span class="behavior-desc">每隔多少条消息触发一次记忆整理</span>
            </div>
            <input
              type="number"
              class="behavior-input"
              v-model.number="agentDraft.reflection_threshold"
              min="1" max="100"
            />
          </div>

          <div v-if="false" class="behavior-item">
            <div class="behavior-label">
              <span>Daily 记忆保留天数</span>
              <span class="behavior-desc">超出后压缩进 Weekly</span>
            </div>
            <input
              type="number"
              class="behavior-input"
              v-model.number="agentDraft.daily_retention_days"
              min="1" max="90"
            />
          </div>

          <div v-if="false" class="behavior-item">
            <div class="behavior-label">
              <span>Weekly 记忆保留周数</span>
              <span class="behavior-desc">超出后提炼进 memory.md（长期记忆）</span>
            </div>
            <input
              type="number"
              class="behavior-input"
              v-model.number="agentDraft.weekly_retention_weeks"
              min="1" max="52"
            />
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

          <div class="behavior-item">
            <div class="behavior-label">
              <span>{{ t('agentConfigUi.indexTtl') }}</span>
              <span class="behavior-desc">{{ t('agentConfigUi.indexTtlHint') }}</span>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
              <input
                type="number"
                class="behavior-input number-input"
                v-model.number="ragIndexTtlDays"
                min="7" max="365"
              />
              <span class="behavior-desc">{{ t('agentConfigUi.days') }}</span>
            </div>
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

      <!-- ── 语音识别模型 ── -->
      <section v-if="activeTab === 'behavior' && behaviorTab === 'voice'" class="config-card">
        <div class="card-head">
          <div class="card-icon" style="--ic:rgba(123,127,178,0.15);--stroke:#7b7fb2">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round">
              <rect x="7.5" y="2" width="5" height="10" rx="2.5"/>
              <path d="M5 9a5 5 0 0 0 10 0M10 14.5V18M7 18h6"/>
            </svg>
          </div>
          <div class="card-title-block">
            <h3>{{ t('agent.voiceTitle') }}</h3>
            <p>{{ t('agentConfigUi.voiceHint') }}</p>
          </div>
        </div>

        <div class="behavior-grid">
          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label"><span>{{ t('agentConfigUi.model') }}</span><span class="behavior-desc">{{ t('agentConfigUi.voiceModelHint') }}</span></div>
            <input type="text" class="behavior-input" style="width:280px" v-model="voiceDraft.model" :placeholder="t('agentConfigUi.voiceModelPlaceholder')" />
          </div>
          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label"><span>{{ t('agentConfigUi.baseUrl') }}</span><span class="behavior-desc">{{ t('agentConfigUi.voiceBaseUrlHint') }}</span></div>
            <input type="text" class="behavior-input" style="width:280px" v-model="voiceDraft.base_url" placeholder="https://…/api/v1/services/aigc/multimodal-generation/generation" />
          </div>
          <div v-if="voiceDraft.api_format === 'dashscope'" class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label"><span>{{ t('agentConfigUi.dashscope') }}</span><span class="behavior-desc">{{ t('agentConfigUi.dashscopeHint') }}</span></div>
            <AdminSelect :model-value="voiceDraft.dashscope_service || 'qwen3-asr'"
                         :options="VOICE_DASHSCOPE_SERVICES"
                         @update:model-value="setDashscopeService" />
          </div>
          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label"><span>{{ t('agentConfigUi.apiFormat') }}</span><span class="behavior-desc">{{ t('agentConfigUi.apiFormatHint') }}</span></div>
            <div style="display:flex;gap:8px;justify-content:flex-end;align-items:center;">
              <button v-for="af in VOICE_API_FORMATS" :key="af.value" type="button" class="btn-ghost"
                      :style="voiceDraft.api_format === af.value ? 'border-color:var(--color-primary);color:var(--color-primary)' : ''"
                      @click="voiceDraft.api_format = af.value">{{ af.label }}</button>
            </div>
          </div>
          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label"><span>{{ t('agentConfigUi.apiKey') }}<span v-if="configStore.secretSet.voiceApiKey" style="margin-left:6px;color:var(--color-primary);font-size:11px;font-weight:600">· {{ t('agentConfigUi.configured') }} ✓</span></span><span class="behavior-desc">{{ t('agentConfigUi.apiKeyHint') }}</span></div>
            <input type="password" class="behavior-input" style="width:280px" v-model="voiceDraft.api_key"
                   :placeholder="configStore.secretSet.voiceApiKey ? t('llmExtraUi.keepUnchanged') : t('agentConfigUi.apiKeyPlaceholder')" />
          </div>
        </div>

        <div class="card-actions">
          <span class="save-hint" :class="{ error: !!voiceError }">
            <template v-if="voiceSaved"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 6l2.5 2.5 5.5-5"/></svg>{{ t('agent.saved') }}</template>
            <template v-else-if="voiceError">{{ voiceError }}</template>
            <template v-else-if="voiceTestMsg">{{ voiceTestMsg }}</template>
          </span>
          <button class="btn-ghost" @click="resetVoice">{{ t('agentConfigUi.undo') }}</button>
          <button class="btn-ghost" :class="{ loading: voiceTesting }" :disabled="voiceTesting" @click="testVoice">
            {{ voiceTesting ? t('agent.testing') : t('agent.testConnection') }}
          </button>
          <button class="btn-primary" :class="{ loading: voiceSaving }" :disabled="voiceSaving" @click="saveVoice">
            <svg v-if="voiceSaving" class="spin-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 1v2M6 9v2M1 6h2M9 6h2"/></svg>
            {{ voiceSaving ? t('agent.saving') : t('agent.save') }}
          </button>
        </div>
      </section>

      <!-- 记忆召回已迁移至独立的 Agent 记忆页面。 -->
      <!--
        <div class="card-head">
          <div class="card-icon" style="--ic:rgba(123,127,178,0.15);--stroke:#7b7fb2">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round">
              <circle cx="5" cy="6" r="2"/><circle cx="15" cy="6" r="2"/><circle cx="10" cy="14" r="2"/>
              <path d="M6.5 7.3l2.2 5.4M13.5 7.3l-2.2 5.4M7 6h6"/>
            </svg>
          </div>
          <div class="card-title-block">
            <h3>向量 Embedding 模型</h3>
            <p>独立于聊天/语音模型，<b>单独 pin 一个</b>——换它会作废所有已存向量、需重建，故意不进模型轮换。用于记忆的语义检索（pattern 超量时按语义挑，而非词法）。<b>关闭 = 退回词法检索</b>，零副作用。支持文本和百炼多模态 Embedding；多模态调用需由业务传入已完成安全校验的图片/视频 URL 或 Base64。</p>
          </div>
        </div>

        <div class="behavior-grid">
          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label">
              <span>启用向量检索</span>
              <span class="behavior-desc">关闭＝退回词法相关性（bigram），零副作用；改完记得下方保存</span>
            </div>
            <ToggleSwitch :model-value="embeddingDraft.enabled" aria-label="切换向量检索" @update:model-value="embeddingDraft.enabled = $event" />
          </div>
          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label"><span>多模态 Embedding</span><span class="behavior-desc">百炼填写 <code>qwen3-vl-embedding</code>；开启后供图片/视频向量调用使用，不改变现有文本记忆索引</span></div>
            <ToggleSwitch :model-value="embeddingDraft.multimodal" aria-label="切换多模态 Embedding" @update:model-value="embeddingDraft.multimodal = $event" />
          </div>
          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label"><span>提供商</span><span class="behavior-desc">选择提供商；通用兼容用于其他 OpenAI 兼容端点</span></div>
            <AdminSelect
              :model-value="embeddingDraft.provider"
              :options="[
                { value: 'bailian', label: '百炼（Bailian）' },
                { value: 'openai', label: 'OpenAI' },
                { value: 'ollama', label: 'Ollama' },
                { value: '', label: '通用 OpenAI 兼容' },
              ]"
              @update:model-value="embeddingDraft.provider = $event"
            />
          </div>
          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label"><span>模型名 model</span><span class="behavior-desc">百炼填 <code>text-embedding-v4</code>；Ollama 填 <code>qwen3-embedding:0.6b</code></span></div>
            <input type="text" class="behavior-input" style="width:280px" v-model="embeddingDraft.model" placeholder="qwen3-embedding:0.6b" />
          </div>
          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label"><span>Base URL</span><span class="behavior-desc">百炼可留空；自定义百炼空间或 Ollama 填到 /v1 那层（不含 /embeddings）</span></div>
            <input type="text" class="behavior-input" style="width:280px" v-model="embeddingDraft.base_url" placeholder="http://…:11434/v1" />
          </div>
          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label"><span>API Key<span v-if="configStore.secretSet.embeddingApiKey" style="margin-left:6px;color:var(--color-primary);font-size:11px;font-weight:600">· 已配置 ✓</span></span><span class="behavior-desc"><b>Ollama 无需鉴权、可留空</b>；用 dashscope / OpenAI 才需填。已存的 Key 不回显，留空＝保留不变</span></div>
            <input type="password" class="behavior-input" style="width:280px" v-model="embeddingDraft.api_key" autocomplete="new-password"
                   :placeholder="configStore.secretSet.embeddingApiKey ? '已配置，留空＝不修改' : 'Ollama 可留空；dashscope/OpenAI 才填'" />
          </div>
          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label"><span>维度 dimensions</span><span class="behavior-desc">0＝用模型默认（qwen3-embedding:0.6b 默认 1024）；部分模型支持指定降维。<b>改了维度＝换模型，需重建向量</b></span></div>
            <input type="number" class="behavior-input number-input" v-model.number="embeddingDraft.dimensions" placeholder="0（模型默认）" />
          </div>
          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label"><span>连通测试</span><span class="behavior-desc">用上面填的参数发一次 embed，看通不通、返回几维（改完先保存再测更准，测试用的是当前输入值）</span></div>
            <div style="display:flex;gap:10px;align-items:center;justify-content:flex-end;min-width:0;">
              <span v-if="embTest.msg" :title="embTest.msg"
                    :style="{ color: embTest.ok ? '#4caf7d' : '#e07070', fontSize:'12px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', minWidth:0 }">
                {{ embTest.msg }}
              </span>
              <button class="btn-ghost" style="flex-shrink:0;" :disabled="embTest.loading" @click="testEmbedding">
                {{ embTest.loading ? '测试中…' : '测试' }}
              </button>
            </div>
          </div>
          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label"><span>重建向量</span><span class="behavior-desc">换了模型/维度后点一次，给所有用户的 pattern + 长期记忆用新模型重算向量（后台跑，期间检索自动退回词法）。日常不用点</span></div>
            <div style="display:flex;gap:10px;align-items:center;justify-content:flex-end;min-width:0;">
              <span v-if="rebuild.msg" :title="rebuild.msg"
                    :style="{ color: rebuild.error ? '#e07070' : '#4caf7d', fontSize:'12px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', minWidth:0 }">
                {{ rebuild.msg }}
              </span>
              <button class="btn-ghost" style="flex-shrink:0;" :disabled="rebuild.running" @click="startRebuild">
                {{ rebuild.running ? `重建中… ${rebuild.done}/${rebuild.total}` : '重建向量' }}
              </button>
            </div>
          </div>
        </div>

        <div class="card-actions">
          <span class="save-hint" :class="{ error: !!embeddingError }">
            <template v-if="embeddingSaved"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 6l2.5 2.5 5.5-5"/></svg>{{ t('agent.saved') }}</template>
            <template v-else-if="embeddingError">{{ embeddingError }}</template>
          </span>
          <button class="btn-ghost" @click="resetEmbedding">撤销修改</button>
          <button class="btn-primary" :class="{ loading: embeddingSaving }" :disabled="embeddingSaving" @click="saveEmbedding">
            <svg v-if="embeddingSaving" class="spin-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 1v2M6 9v2M1 6h2M9 6h2"/></svg>
            {{ embeddingSaving ? '保存中…' : '保存' }}
          </button>
        </div>
      </section>

      -->

      <!-- ── 状态命名 ── -->
      <StateLabelsPanel v-if="activeTab === 'behavior' && behaviorTab === 'labels'" />

      <!-- ── 用量统计 ── -->
      <UsagePanel v-if="activeTab === 'usage'" />

    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { useRoute } from 'vue-router'
import LocalCapabilityOverrides from './components/LocalCapabilityOverrides.vue'
import PermissionSettings from './components/PermissionSettings.vue'
import CapabilityCatalogPanel from './capabilities/components/CapabilityCatalogPanel.vue'
import UsagePanel from './observability/components/UsagePanel.vue'
import PromptPanel from './prompting/components/PromptPanel.vue'
import StateLabelsPanel from './prompting/components/StateLabelsPanel.vue'
import { useAgentRuntimeConfig } from './runtime-config/useAgentRuntimeConfig'
import { useLlmPresets } from './llm/useLlmPresets'
import AdminSelect from '@/components/AdminSelect.vue'
import { useConfigStore } from '@/stores/config'
import { useAdminStore } from '@/stores/admin'
import ConfigField from '../Config/components/ConfigField.vue'
import AdminSegmentTabs from '@/components/admin/AdminSegmentTabs.vue'
import LlmPresetEditor from './llm/components/LlmPresetEditor.vue'
import DeepResearchConfig from './runtime-config/components/DeepResearchConfig.vue'
import SimilarImageConfig from './runtime-config/components/SimilarImageConfig.vue'
import { useI18n } from 'vue-i18n'
import { MODEL_PROVIDERS } from '@/utils/modelProviders'
import { RiCheckFill } from '@remixicon/vue'

const configStore = useConfigStore()
const adminStore  = useAdminStore()
const route = useRoute()
const { t } = useI18n()
const standaloneMode = computed(() => route.path === '/agent-behavior' ? 'behavior' : route.path === '/agent-usage' ? 'usage' : '')
const runtimeConfig = useAgentRuntimeConfig()
const { agentDraft, behaviorSaving, behaviorSaved, behaviorError, resetBehavior, saveBehavior, generalSearchDraft, ragIndexTtlDays, deepResearchDraft, similarImageDraft, generalSearchSaving, generalSearchSaved, generalSearchError, deepResearchSaving, deepResearchSaved, deepResearchError, deepResearchTest, similarImageSaving, similarImageSaved, similarImageError, resetGeneralSearch, resetDeepResearch, resetSimilarImageSearch, voiceDraft, voiceSaving, voiceSaved, voiceError, voiceTesting, voiceTestMsg, VOICE_API_FORMATS, VOICE_DASHSCOPE_SERVICES, resetVoice, setDashscopeService, saveVoice, testVoice, searchTest, testSearch, testDeepResearch, saveDeepResearch, saveSearch } = runtimeConfig
const llmPresets = useLlmPresets(adminStore, configStore, agentDraft)
const { presets, activePresetId, strategy, poolMode, presetsLoading, llmMsg, llmMsgError, llmMsgSuccess, testingId, activatingId, probingId, probingDim, showMsg, fetchPresets, setStrategy, setPoolMode, saveConcurrency, activatePreset, deletePreset, testPreset } = llmPresets
const byokDraft = reactive({ ...configStore.cfg.byok })
const permissionSaving = ref(false)
const permissionSaved = ref(false)
const permissionError = ref('')

const tabs = computed(() => [
  { key: 'llm',      label: t('agent.llm') },
  { key: 'permissions', label: t('agent.permissions') },
  { key: 'prompts',  label: t('agent.prompts') },
])
const activeTab = ref(standaloneMode.value || 'llm')
const behaviorTabs = computed(() => [
  { key: 'runtime', label: t('agent.runtime') },
  { key: 'search', label: t('agent.search') },
  { key: 'voice', label: t('agent.voice') },
  { key: 'capabilities', label: t('agent.capabilities') },
  { key: 'labels', label: t('agent.labels') },
])
const behaviorTab = ref('runtime')

function switchTab(key: string) {
  activeTab.value = key
  if (key === 'llm'     && presets.value.length === 0) fetchPresets()
}

// ── LLM 预设 ──────────────────────────────────────────────────────────────
const PROVIDERS = computed(() => [
  ...MODEL_PROVIDERS.map(provider => ({ key: provider.value, label: t(provider.labelKey), base_url: provider.base_url, model: provider.model })),
])

// MiMo 同时提供 OpenAI / Anthropic 两套兼容 API，按预设选格式（影响后端走哪条通道）
const API_FORMATS = computed(() => [
  { key: 'openai',    label: t('adminAgentUi.formatOpenai') },
  { key: 'anthropic', label: t('adminAgentUi.formatAnthropic') },
])

const capabilityProbeLoading = ref(false)
const capabilityProbeResult = ref<Record<string, { status?: string; detail?: string }>>({})

// 多模态三维度：图片→vision，视频→vision_video，音频→vision_audio
const visionDims = computed(() => [
  { key: 'image', label: t('agent.image'), hint: t('adminAgentUi.imageHint') },
  { key: 'video', label: t('agent.video'), hint: t('adminAgentUi.videoHint') },
  { key: 'audio', label: t('agent.audio'), hint: t('adminAgentUi.audioHint') },
])
const DEEPSEEK_EFFORTS = computed(() => [
  { key: '', label: t('adminAgentUi.defaultOption') },
  { key: 'low', label: t('adminAgentUi.low') },
  { key: 'high', label: t('adminAgentUi.high') },
  { key: 'max', label: t('adminAgentUi.maximum') },
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
  temperature: number
  context_tokens: number
  thinking: string
  vision: boolean
  vision_video: boolean
  vision_audio: boolean
  capability_overrides: Record<string, boolean>
}
const editTarget   = ref<LlmPresetDraft | null>(null)
const editClosing  = ref(false)
const editIsNew    = ref(false)
const editSaving   = ref(false)
const editError    = ref('')
const editMaskDown = ref(false)
const modelOptions = ref<string[]>([])
const modelListLoading = ref(false)
const modelListError = ref('')
const modelMenuOpen = ref(false)
const filteredModelOptions = computed(() => {
  const query = String(editTarget.value?.model || '').trim().toLowerCase()
  if (!query) return modelOptions.value
  return modelOptions.value.filter(model => model.toLowerCase().includes(query))
})


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
  editTarget.value = { name: '', provider: 'openai', api_key: '', base_url: PROVIDERS.value[0].base_url, model: PROVIDERS.value[0].model, max_tokens: 8000, temperature: 0.7, context_tokens: 128000, thinking: 'disabled', reasoning_effort: '', vision: false, vision_detail: 'auto', vision_video: false, vision_audio: false, api_format: '', ollama_mode: 'local', ollama_api_mode: 'native', ollama_keep_alive: '5m', deployment_mode: 'cloud', local_runtime: 'other', capability_overrides: {} }
  editError.value  = ''
  modelOptions.value = []
  modelListError.value = ''
  modelMenuOpen.value = false
  capabilityProbeResult.value = {}
}

function openEditPreset(p: LlmPresetRecord) {
  editClosing.value = false
  editIsNew.value  = false
  editTarget.value = { ...p, api_key: '', max_tokens: p.max_tokens ?? 8000, context_tokens: p.context_tokens ?? 128000, vision_detail: p.vision_detail || 'auto', ollama_mode: p.ollama_mode || 'local', ollama_api_mode: p.ollama_api_mode || 'native', ollama_keep_alive: p.ollama_keep_alive || '5m', deployment_mode: p.deployment_mode || (p.provider === 'local' ? 'local' : 'cloud'), local_runtime: p.local_runtime || 'other', capability_overrides: p.capability_overrides || {} } as unknown as LlmPresetDraft
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

function closeModelMenuSoon() {
  window.setTimeout(() => { modelMenuOpen.value = false }, 120)
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
  target.base_url = pv.base_url
  target.model    = pv.model
  // mimo 同时提供两套 API：默认 openai 格式；切到别的 provider 清掉（走自动判定）
  target.api_format = key === 'mimo' ? 'openai' : ''
  target.deployment_mode = key === 'local' ? 'local' : 'cloud'
  target.ollama_mode = key === 'ollama' ? 'local' : (target.ollama_mode || 'local')
  if (key === 'ollama') {
    target.ollama_api_mode = target.ollama_api_mode || 'native'
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
    target.base_url = variant === 'coding'
      ? 'https://open.bigmodel.cn/api/coding/paas/v4'
      : 'https://open.bigmodel.cn/api/paas/v4'
  } else if (provider === 'local') {
    target.local_runtime = variant
  } else if (provider === 'ollama' && (variant === 'local' || variant === 'cloud')) {
    setOllamaMode(variant)
  }
}

function setOllamaMode(mode: 'local' | 'cloud') {
  if (!editTarget.value || editTarget.value.provider !== 'ollama') return
  editTarget.value.ollama_mode = mode
  editTarget.value.base_url = mode === 'cloud'
    ? 'https://ollama.com/v1'
    : 'http://127.0.0.1:11434/v1'
  if (mode === 'local') editTarget.value.api_key = ''
  modelOptions.value = []
  modelListError.value = ''
}

// 选 API 格式时，同步切换 mimo 端点后缀（host 保留，只改 /v1 ↔ /anthropic）
function pickApiFormat(fmt: string) {
  const target = editTarget.value
  if (!target) return
  target.api_format = fmt
  const bu = (target.base_url || '').replace(/\/(v1|anthropic)\/?$/, '')
  if (bu.includes('xiaomimimo')) {
    target.base_url = bu + (fmt === 'anthropic' ? '/anthropic' : '/v1')
  }
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


// 多模态探测：发极小媒体给该预设模型，按响应判定是否支持对应维度，结论自动写回。
// 卡片按钮不传 dim → 依次测图片/视频/音频三维度；弹窗内按钮传 dim → 只测单维度。
async function probeVision(id: string | number | undefined, dim?: string) {
  const target = editTarget.value
  if (dim && !target) return
  if (dim) {
    probingDim.value = dim
  } else {
    probingId.value = id === undefined ? null : id
  }
  try {
    const isDraft = Boolean(dim && !id && target)
    const url = isDraft
      ? `/api/v1/admin/agent/llm-presets/probe-vision-preview?dim=${dim}`
      : `/api/v1/admin/agent/llm-presets/${id}/probe-vision` + (dim ? `?dim=${dim}` : '')
    const res = await adminStore.authFetch(url, {
      method: 'POST',
      ...(isDraft ? {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: target!.provider,
          api_key: target!.api_key,
          base_url: target!.base_url,
          model: target!.model,
          api_format: target!.api_format || '',
        }),
      } : {}),
    })
    const data = await res.json()
    if (dim) {
      // 单维度（弹窗内）
      const label = visionDims.value.find(d => d.key === dim)?.label || dim
      if (data.supported === true)       showMsg(t('adminAgentUi.dimensionSupported', { label }), false, true)
      else if (data.supported === false) showMsg(t('adminAgentUi.dimensionUnsupported', { label, detail: data.detail }), true)
      else                               showMsg(t('adminAgentUi.dimensionUnknown', { label, detail: data.detail }), true)
      if (data.supported === true || data.supported === false) {
        const field = dim === 'image' ? 'vision' : 'vision_' + dim
        target![field] = data.supported
      }
    } else {
      // 全维度（卡片）
      const results = data.results || {}
      const ok: string[] = [], no: string[] = [], unk: string[] = []
      for (const d of visionDims.value) {
        const r = results[d.key]
        if (!r) continue
        if (r.supported === true) ok.push(d.label)
        else if (r.supported === false) no.push(d.label)
        else unk.push(d.label)
      }
      const parts: string[] = []
      if (ok.length) parts.push(t('adminAgentUi.supportedList', { values: ok.join('、') }))
      if (no.length) parts.push(t('adminAgentUi.unsupportedList', { values: no.join('、') }))
      if (unk.length) parts.push(t('adminAgentUi.unknownList', { values: unk.join('、') }))
      showMsg(parts.length ? t('adminAgentUi.probeComplete', { details: parts.join('；') }) : t('adminAgentUi.probeNoResult'))
    }
    await fetchPresets()   // 刷新卡片徽章
  } catch (e) {
    showMsg(t('adminAgentUi.probeFailed', { message: e instanceof Error ? e.message : String(e) }), true)
  } finally {
    probingId.value = null
    probingDim.value = null
  }
}

// ── 初始化 ────────────────────────────────────────────────────────────────
onMounted(async () => {
  await configStore.fetchConfig()
  Object.assign(agentDraft, configStore.cfg.agent)
  Object.assign(byokDraft, configStore.cfg.byok)
  resetGeneralSearch()
  resetSimilarImageSearch()
  Object.assign(voiceDraft, configStore.cfg.voice)
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
}
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
  margin-top: 18px; padding-top: 16px;
  border-top: 1px solid rgba(255,255,255,0.07);
}
.save-hint {
  flex: 1; font-size: 12px; color: #5ab899;
  display: flex; align-items: center; gap: 5px;
}
.save-hint.muted { color: rgba(255,255,255,0.28); }
.save-hint.error { color: #e07878; }

.btn-ghost {
  padding: 6px 14px; border-radius: 9px;
  border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.06);
  color: rgba(255,255,255,0.45); font-size: 13px; cursor: pointer; transition: all 0.15s;
}
.btn-ghost:hover { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.7); }
.btn-primary {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 16px; border-radius: 9px; border: none;
  background: var(--action-primary-bg);
  color: white; font-size: 13px; font-weight: 600;
  cursor: pointer; transition: opacity 0.15s;
  box-shadow: none;
}
.btn-primary:hover:not(:disabled) { opacity: 0.88; }
.btn-primary:disabled { opacity: 0.5; cursor: default; }

/* ── 行为配置 ── */
.behavior-grid {
  display: flex; flex-direction: column; gap: 2px;
}
.behavior-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 0;
  border-bottom: 1px solid rgba(255,255,255,0.06);
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

/* ── LLM 预设 ── */
.presets-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  margin-bottom: 16px;
}
.presets-title { font-size: 16px; font-weight: 700; color: rgba(255,255,255,0.88); }
.presets-desc  { font-size: 12px; color: rgba(255,255,255,0.35); margin-top: 4px; }
.presets-header-right { display: flex; align-items: center; gap: 10px; }
.presets-header-right > .btn-primary { min-height: 34px; box-sizing: border-box; }
.strategy-select { display: flex; align-items: center; gap: 6px; min-height: 34px; font-size: 12px; color: rgba(255,255,255,0.5); }
.pca-btn--pool-on { background: rgba(123,127,178,0.22); color: rgba(180,176,224,1); }
.conc-input {
  width: 52px; height: 34px; box-sizing: border-box;
  border-radius: 8px; font-size: 12px; padding: 5px 8px; outline: none; text-align: center;
}
.presets-loading { padding: 40px 0; text-align: center; font-size: 13px; color: rgba(255,255,255,0.25); }

.preset-list { display: flex; flex-direction: column; gap: 8px; }

.preset-card {
  display: flex; align-items: center; gap: 14px;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08); border-radius: 14px;
  padding: 14px 16px;
  transition: border-color 0.2s, background 0.2s;
}
.preset-card--active {
  background: rgba(123,127,178,0.1);
  border-color: rgba(123,127,178,0.3);
}

.preset-card-left { flex-shrink: 0; }
.provider-dot {
  display: block; width: 10px; height: 10px; border-radius: 50%;
  flex-shrink: 0;
}
.dot-openai    { background: #74c69d; }
.dot-anthropic { background: #e08060; }
.dot-qwen      { background: #60aedb; }
.dot-deepseek  { background: #6090d8; }
.dot-minimax   { background: #9590c4; }
.dot-mimo      { background: #ff6a00; }
.preset-card-body { flex: 1; min-width: 0; }
.preset-card-top  { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.preset-name { font-size: 14px; font-weight: 600; color: rgba(255,255,255,0.88); }
.active-badge {
  font-size: 10px; font-weight: 700; letter-spacing: 0.05em;
  padding: 1px 7px; border-radius: 20px;
  background: rgba(123,127,178,0.25); color: rgba(169,164,216,0.9);
  border: 1px solid rgba(123,127,178,0.35);
}
.provider-label {
  font-size: 11px; color: rgba(255,255,255,0.28);
  background: rgba(255,255,255,0.06); border-radius: 5px; padding: 1px 6px;
}
.preset-card-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 5px 12px; min-width: 0; }
.preset-model { font-size: 12px; color: rgba(255,255,255,0.55); white-space: nowrap; }
.preset-meta-item { font-size: 12px; color: rgba(255,255,255,0.35); white-space: nowrap; flex-shrink: 0; }
.preset-meta-think, .preset-meta-vision { display: inline-flex; align-items: center; gap: 3px; }
.preset-meta-think { color: rgba(149,144,196,0.85); background: rgba(149,144,196,0.1); padding: 1px 6px; border-radius: 4px; }
.preset-meta-vision { color: rgba(122,184,200,0.95); background: rgba(122,184,200,0.12); padding: 1px 6px; border-radius: 4px; }
/* key 独占整行、过长截断带省略号（悬停看全文），不再撑破页面宽度 */
.preset-key   { flex: 1 1 100%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 11px; color: rgba(255,255,255,0.28); font-family: var(--font-family-mono); }

.preset-card-actions { display: flex; gap: 6px; align-items: center; flex-shrink: 0; }
.pca-btn {
  padding: 5px 12px; border-radius: 8px; font-size: 12px; font-weight: 500;
  border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05);
  color: rgba(255,255,255,0.5); cursor: pointer; transition: all 0.15s;
}
.pca-btn:hover { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.75); }
.pca-btn--sm { padding: 4px 10px; font-size: 11px; }
.pca-btn:disabled { opacity: 0.5; cursor: default; }

.pca-btn--activate {
  border-color: rgba(123,127,178,0.3); background: rgba(123,127,178,0.1);
  color: rgba(169,164,216,0.85);
}
.pca-btn--activate:hover { background: rgba(123,127,178,0.2); color: rgba(169,164,216,1); }
.pca-btn--del { color: rgba(200,100,100,0.7); }
.pca-btn--del:hover { background: rgba(200,80,80,0.12); color: rgba(220,100,100,0.9); }
.pca-btn--testing, .pca-btn--activating { opacity: 0.6; cursor: default; }

.llm-msg {
  display: flex; align-items: center; gap: 4px;
  margin-top: 12px; padding: 10px 14px; border-radius: 10px;
  font-size: 13px; color: #5ab899;
  background: rgba(90,184,153,0.1); border: 1px solid rgba(90,184,153,0.2);
}
.llm-msg__icon { width: 1em; height: 1em; flex: 0 0 auto; }
.llm-msg--error {
  color: #e07878;
  background: rgba(220,100,100,0.1); border-color: rgba(220,100,100,0.2);
}


</style>
