<template>
  <div class="agent-page">

    <div class="page-header">
      <div class="page-title-block">
        <h2 class="page-title">{{ standaloneMode === 'behavior' ? 'Agent 能力' : standaloneMode === 'usage' ? 'Agent 用量统计' : 'Agent 配置' }}</h2>
        <p class="page-desc">{{ standaloneMode ? '独立管理 Agent 运行参数与用量数据' : '管理 LLM 连接、系统提示词与行为参数' }}</p>
      </div>
    </div>

    <!-- 标签栏 -->
    <AdminSegmentTabs v-if="!standaloneMode" :model-value="activeTab" :tabs="tabs" aria-label="Agent 配置分类" class="agent-tabs" @update:model-value="switchTab" />

    <AdminSegmentTabs v-if="activeTab === 'behavior'" v-model="behaviorTab" :tabs="behaviorTabs" aria-label="Agent 能力分类" class="behavior-tabs" />

    <div class="panels-wrap">

      <!-- ── 能力目录 ── -->
      <CapabilityCatalogPanel v-if="activeTab === 'behavior' && behaviorTab === 'capabilities'" />

      <!-- ── LLM 预设 ── -->
      <div v-if="activeTab === 'llm'">
        <!-- 标题行 -->
        <div class="presets-header">
          <div>
            <h3 class="presets-title">LLM 预设</h3>
            <p class="presets-desc">管理多套模型配置；选模型策略 = 单一激活 / 多 key 分流 / 智能路由</p>
          </div>
          <div class="presets-header-right">
            <label class="strategy-select" title="worker 同时跑几条 agent。单 key 安全上限≈16，多 key 分流可设 key数×16。改完 ≤30s 热生效">
              <span>并发</span>
              <input type="number" min="1" max="64" class="conc-input"
                     v-model.number="agentDraft.worker_concurrency" @change="saveConcurrency" />
            </label>
            <div class="strategy-select">
              <span>策略</span>
              <AdminSelect
                :model-value="strategy"
                :options="[
                  { value: 'active', label: '单一激活' },
                  { value: 'pool',   label: '多 key 分流' },
                  { value: 'router', label: '智能路由（待接入）' },
                ]"
                @update:model-value="setStrategy"
              />
            </div>
            <div v-if="strategy === 'pool'" class="strategy-select" title="随机=简单均匀；轮询=严格交替；最少在途=自动多发给快的 key、避开慢的（key 速度差异大时最优）">
              <span>分流</span>
              <AdminSelect
                :model-value="poolMode"
                :options="[
                  { value: 'random',       label: '随机' },
                  { value: 'round_robin',  label: '轮询' },
                  { value: 'least_loaded', label: '最少在途' },
                ]"
                @update:model-value="setPoolMode"
              />
            </div>
            <button class="btn-primary" @click="openNewPreset">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6.5 1v11M1 6.5h11"/></svg>
            新建预设
            </button>
          </div>
        </div>

        <div v-if="presetsLoading" class="presets-loading">加载中…</div>

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
                <span v-if="p.id === activePresetId" class="active-badge">当前</span>
                <span class="provider-label">{{ p.provider }}</span>
              </div>
              <div class="preset-card-meta">
                <span class="preset-model">{{ p.model }}</span>
                <span class="preset-meta-item">out {{ p.max_tokens ?? 4000 }}</span>
                <span class="preset-meta-item">ctx {{ p.context_tokens ?? 120000 }}</span>
                <span class="preset-meta-item">temp {{ p.temperature ?? 0.7 }}</span>
                <span v-if="p.thinking === 'adaptive'" class="preset-meta-item preset-meta-think"><Icon name="admin.brain" size="xs" />思考</span>
                <span v-if="p.vision" class="preset-meta-item preset-meta-vision"><Icon name="admin.eye" size="xs" />图片</span>
                <span v-if="p.vision_video" class="preset-meta-item preset-meta-vision"><Icon name="admin.video" size="xs" />视频</span>
                <span v-if="p.vision_audio" class="preset-meta-item preset-meta-vision"><Icon name="admin.microphone" size="xs" />音频</span>
                <span class="preset-key" :title="typeof p.api_key === 'string' ? p.api_key : '未设置 Key'">{{ typeof p.api_key === 'string' ? p.api_key : '未设置 Key' }}</span>
              </div>
            </div>
            <div class="preset-card-actions">
              <button v-if="strategy === 'pool'" class="pca-btn" :class="{ 'pca-btn--pool-on': p.in_pool }" @click="togglePool(p)">
                {{ p.in_pool ? '✓ 分流中' : '加入分流' }}
              </button>
              <button class="pca-btn" @click="openEditPreset(p)">编辑</button>
              <button class="pca-btn" :class="{ 'pca-btn--testing': testingId === p.id }" @click="testPreset(p.id)">
                {{ testingId === p.id ? '测试中…' : '测试' }}
              </button>
              <button class="pca-btn" :class="{ 'pca-btn--testing': probingId === p.id }" @click="probeVision(p.id)">
                {{ probingId === p.id ? '检测中…' : '检测多模态' }}
              </button>
              <button
                v-if="p.id !== activePresetId"
                class="pca-btn pca-btn--activate"
                :class="{ 'pca-btn--activating': activatingId === p.id }"
                @click="activatePreset(p.id)"
              >{{ activatingId === p.id ? '切换中…' : '设为当前' }}</button>
              <button
                v-if="p.id !== activePresetId"
                class="pca-btn pca-btn--del"
                @click="deletePreset(p.id)"
              >删除</button>
            </div>
          </div>
        </div>

        <div v-if="llmMsg" class="llm-msg" :class="{ 'llm-msg--error': llmMsgError }">{{ llmMsg }}</div>
      </div>

      <LlmPresetEditor
        v-if="editTarget"
        :draft="editTarget"
        :is-new="editIsNew"
        :saving="editSaving"
        :error="editError"
        :providers="PROVIDERS"
        :local-runtimes="LOCAL_RUNTIMES"
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
        @close="editTarget = null"
        @save="savePreset"
        @set-provider="setEditProvider"
        @set-ollama-mode="setOllamaMode"
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
            <h3>运行行为</h3>
            <p>控制 Agent 的工具权限、上下文压缩和 IM 运行行为。</p>
          </div>
        </div>

        <div class="behavior-grid">
          <div v-if="behaviorTab === 'runtime'" class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label">
              <span>Shell 工具总开关</span>
              <span class="behavior-desc">默认关闭。开启后才允许用户使用 Shell；默认执行后端是 Docker 沙盒，沙盒状态和镜像配置在“Shell 沙盒”页面管理。</span>
            </div>
            <ToggleSwitch :model-value="agentDraft.shell_enabled" aria-label="切换 Shell 工具总开关" @update:model-value="agentDraft.shell_enabled = $event; saveBehavior()" />
          </div>

          <div v-if="behaviorTab === 'runtime'" class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label"><span>Shell Autopilot 总开关</span><span class="behavior-desc">允许用户在个人设置中开启 Autopilot，跳过 Shell 确认门；沙盒、配额、超时和审计仍然生效。</span></div>
            <ToggleSwitch :model-value="agentDraft.shell_autopilot_enabled" :disabled="!agentDraft.shell_enabled" aria-label="切换 Shell Autopilot 总开关" @update:model-value="agentDraft.shell_autopilot_enabled = $event; saveBehavior()" />
          </div>

          <div v-if="behaviorTab === 'runtime'" class="behavior-item">
            <div class="behavior-label"><span>系统范围 Shell</span><span class="behavior-desc">允许访问系统范围，风险最高；建议仅本地管理员使用。</span></div>
            <ToggleSwitch :model-value="agentDraft.shell_system_enabled" :disabled="!agentDraft.shell_enabled" aria-label="切换系统范围 Shell" @update:model-value="agentDraft.shell_system_enabled = $event; saveBehavior()" />
          </div>

          <div v-if="behaviorTab === 'runtime'" class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label">
              <span>危险 Shell 命令</span>
              <span class="behavior-desc">默认关闭。包括删除、覆盖、移动目录，修改权限，以及重启或停止服务等高影响命令；仍需用户逐次确认，不会绕过确认门。</span>
            </div>
            <ToggleSwitch :model-value="agentDraft.shell_dangerous_enabled" :disabled="!agentDraft.shell_enabled" aria-label="切换危险 Shell 命令" @update:model-value="agentDraft.shell_dangerous_enabled = $event; saveBehavior()" />
          </div>

          <div v-if="behaviorTab === 'runtime'" class="behavior-item">
            <div class="behavior-label">
              <span>对话历史压缩</span>
              <span class="behavior-desc">超长会话把旧消息总结成摘要省 token；关闭后只截断不摘要</span>
            </div>
            <ToggleSwitch :model-value="agentDraft.conv_compress_enabled" aria-label="切换对话历史压缩" @update:model-value="agentDraft.conv_compress_enabled = $event; saveBehavior()" />
          </div>

          <div v-if="behaviorTab === 'runtime'" class="behavior-item">
            <div class="behavior-label">
              <span>IM 慢工具进度声明</span>
              <span class="behavior-desc">多步工具循环期间先发一句"我去查一下"再执行，减少 IM 非流式的长时间沉默感；文案来自工具自身登记的固定文案，不是模型现场生成；只在 IM 生效，网页不受影响</span>
            </div>
            <ToggleSwitch :model-value="agentDraft.im_progress_announce_enabled" aria-label="切换 IM 慢工具进度声明" @update:model-value="agentDraft.im_progress_announce_enabled = $event; saveBehavior()" />
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
            <template v-if="behaviorSaved"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 6l2.5 2.5 5.5-5"/></svg>已保存</template>
            <template v-else-if="behaviorError">{{ behaviorError }}</template>
          </span>
          <button class="btn-ghost" @click="resetBehavior">撤销修改</button>
          <button class="btn-primary" :class="{ loading: behaviorSaving }" :disabled="behaviorSaving" @click="saveBehavior">
            <svg v-if="behaviorSaving" class="spin-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 1v2M6 9v2M1 6h2M9 6h2"/></svg>
            {{ behaviorSaving ? '保存中…' : '保存' }}
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
            <h3>联网搜索</h3>
            <p>通用搜索走自建 SearXNG（免费、不计配额）；深度研究使用下方独立的 Provider 配置。</p>
          </div>
        </div>

        <div class="behavior-grid">
          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label">
              <span>站内全局搜索后端</span>
              <span class="behavior-desc">默认使用 ILIKE 兼容查询；持久化 BM25 索引可作为灰度路径开启。索引未覆盖的来源仍继续使用兼容查询。</span>
            </div>
            <AdminSelect
              :model-value="generalSearchDraft.global_search_backend"
              :options="[
                { value: 'index', label: '持久化索引（BM25）' },
                { value: 'ilike', label: 'ILIKE 兼容模式' },
              ]"
              @update:model-value="generalSearchDraft.global_search_backend = $event"
            />
          </div>
          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label">
              <span>SearXNG 地址（通用搜索 web_search）</span>
              <span class="behavior-desc">自建 SearXNG 实例地址，留空=禁用通用搜索。同机填 http://127.0.0.1:端口，内网/1Panel 部署填对应内网 IP:端口</span>
            </div>
            <div style="display:flex; align-items:center; gap:10px; justify-content:flex-end; min-width:0;">
              <span v-if="searchTest.searxng.msg" :title="searchTest.searxng.msg"
                    :style="{ color: searchTest.searxng.ok ? '#4caf7d' : '#e07070', fontSize:'12px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', minWidth:0 }">
                {{ searchTest.searxng.msg }}
              </span>
              <button class="btn-ghost" style="flex-shrink:0;" :disabled="searchTest.searxng.loading" @click="testSearch('searxng')">
                {{ searchTest.searxng.loading ? '测试中…' : '测试' }}
              </button>
              <input
                type="text"
                class="behavior-input"
                style="width: 280px; flex-shrink:0;"
                v-model="generalSearchDraft.searxng_url"
                placeholder="http://127.0.0.1:8888（留空=禁用）"
              />
            </div>
          </div>

          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label">
              <span>SearXNG 引擎（文本搜索 web_search）</span>
              <span class="behavior-desc">逗号分隔；默认使用已登记的通用网页引擎，可按部署环境实测后调整</span>
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
              <span>图片搜索引擎（image_search）</span>
              <span class="behavior-desc">逗号分隔，留空则回退复用上面的文本引擎列表。图片分类能连通的引擎不一定和文本分类是同一批，部署后建议用测试按钮实测调整</span>
            </div>
            <div style="display:flex; align-items:center; gap:10px; justify-content:flex-end; min-width:0;">
              <span v-if="searchTest.searxng_images.msg" :title="searchTest.searxng_images.msg"
                    :style="{ color: searchTest.searxng_images.ok ? '#4caf7d' : '#e07070', fontSize:'12px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', minWidth:0 }">
                {{ searchTest.searxng_images.msg }}
              </span>
              <button class="btn-ghost" style="flex-shrink:0;" :disabled="searchTest.searxng_images.loading" @click="testSearch('searxng_images')">
                {{ searchTest.searxng_images.loading ? '测试中…' : '测试' }}
              </button>
              <input
                type="text"
                class="behavior-input"
                style="width: 280px; flex-shrink:0;"
                v-model="generalSearchDraft.searxng_image_engines"
                placeholder="留空=复用文本引擎"
              />
            </div>
          </div>

          <div class="behavior-item">
            <div class="behavior-label">
              <span>默认返回结果数</span>
              <span class="behavior-desc">web_search / image_search 每次搜索返回多少条，范围 1～20</span>
            </div>
            <input
              type="number"
              class="behavior-input"
              v-model.number="generalSearchDraft.max_results"
              min="1" max="20"
            />
          </div>

          <div class="behavior-item">
            <div class="behavior-label">
              <span>RAG 索引缓存保留时间</span>
              <span class="behavior-desc">长期未使用的用户索引会自动清理；索引可由业务数据重新生成，范围 7～365 天</span>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
              <input
                type="number"
                class="behavior-input"
                style="width: 120px;"
                v-model.number="ragIndexTtlDays"
                min="7" max="365"
              />
              <span class="behavior-desc">天</span>
            </div>
          </div>

        </div>

        <div class="card-actions">
          <span class="save-hint" :class="{ error: !!generalSearchError }">
            <template v-if="generalSearchSaved"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 6l2.5 2.5 5.5-5"/></svg>已保存</template>
            <template v-else-if="generalSearchError">{{ generalSearchError }}</template>
          </span>
          <button class="btn-ghost" @click="resetGeneralSearch">撤销修改</button>
          <button class="btn-primary" :class="{ loading: generalSearchSaving }" :disabled="generalSearchSaving" @click="saveSearch('general')">
            <svg v-if="generalSearchSaving" class="spin-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 1v2M6 9v2M1 6h2M9 6h2"/></svg>
            {{ generalSearchSaving ? '保存中…' : '保存' }}
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

      <!-- ── 相似图搜索 ── -->
      <section v-if="activeTab === 'behavior' && behaviorTab === 'search'" class="config-card">
        <div class="card-head">
          <div class="card-icon" style="--ic:rgba(218,157,111,0.15);--stroke:#da9d6f">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round">
              <circle cx="8.5" cy="8.5" r="5.5"/>
              <path d="M12.5 12.5L17 17M6.5 8.5h4M8.5 6.5v4"/>
            </svg>
          </div>
          <div class="card-title-block">
            <h3>相似图搜索</h3>
            <p>使用百度千帆根据用户图片查找相似候选；独立于关键词图片搜索和通用联网搜索。</p>
          </div>
        </div>

        <div class="behavior-grid">
          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label">
              <span>百度千帆 API Key</span>
              <span class="behavior-desc">Web/私聊所有者可用，群成员需显式加入 Bot 工具白名单</span>
            </div>
            <div style="display:flex; align-items:center; gap:10px; justify-content:flex-end; min-width:0;">
              <span v-if="searchTest.baidu_similar_images.msg" :title="searchTest.baidu_similar_images.msg"
                    :style="{ color: searchTest.baidu_similar_images.ok ? '#4caf7d' : '#e07070', fontSize:'12px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', minWidth:0 }">
                {{ searchTest.baidu_similar_images.msg }}
              </span>
              <button class="btn-ghost" style="flex-shrink:0;" :disabled="searchTest.baidu_similar_images.loading" @click="testSearch('baidu_similar_images')">
                {{ searchTest.baidu_similar_images.loading ? '测试中…' : '测试' }}
              </button>
              <Checkbox v-model="similarImageDraft.similar_image_enabled" aria-label="启用百度千帆相似图搜索" />
              <input type="password" class="behavior-input" style="width:280px; flex-shrink:0;"
                     v-model="similarImageDraft.baidu_qianfan_api_key" autocomplete="new-password"
                     placeholder="百度 API Key（留空=不修改）" />
            </div>
          </div>

          <div class="behavior-item">
            <div class="behavior-label">
              <span>默认结果数</span>
              <span class="behavior-desc">范围 1～50；用户也可以在对话中指定数量</span>
            </div>
            <input type="number" class="behavior-input" v-model.number="similarImageDraft.similar_image_default_count" min="1" max="50" />
          </div>

          <div class="behavior-item">
            <div class="behavior-label">
              <span>每日限额</span>
              <span class="behavior-desc">按用户统计</span>
            </div>
            <input type="number" class="behavior-input" v-model.number="similarImageDraft.similar_image_limit_daily" min="1" />
          </div>

          <div class="behavior-item">
            <div class="behavior-label">
              <span>请求超时</span>
              <span class="behavior-desc">范围 5～60 秒</span>
            </div>
            <input type="number" class="behavior-input" v-model.number="similarImageDraft.similar_image_timeout_seconds" min="5" max="60" />
          </div>
        </div>

        <div class="card-actions">
          <span class="save-hint" :class="{ error: !!similarImageError }">
            <template v-if="similarImageSaved"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 6l2.5 2.5 5.5-5"/></svg>已保存</template>
            <template v-else-if="similarImageError">{{ similarImageError }}</template>
          </span>
          <button class="btn-ghost" @click="resetSimilarImageSearch">撤销修改</button>
          <button class="btn-primary" :class="{ loading: similarImageSaving }" :disabled="similarImageSaving" @click="saveSearch('similar')">
            <svg v-if="similarImageSaving" class="spin-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 1v2M6 9v2M1 6h2M9 6h2"/></svg>
            {{ similarImageSaving ? '保存中…' : '保存' }}
          </button>
        </div>
      </section>

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
            <h3>语音识别模型</h3>
            <p>独立于主模型，把语音 / 音视频转成文字后交主模型处理（主模型不再被强切）。<b>留空 = 不支持语音</b>（咕咕收到语音回「不支持」）。请求格式由下方 API 配置决定，不根据 provider 猜测。</p>
          </div>
        </div>

        <div class="behavior-grid">
          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label"><span>模型名 model</span><span class="behavior-desc"><b>留空 = 不支持语音</b>。DashScope 会根据下方产品线自动使用对应请求格式；当前支持同步短音频接口，Filetrans 长录音任务暂未接入</span></div>
            <input type="text" class="behavior-input" style="width:280px" v-model="voiceDraft.model" placeholder="留空=不支持语音" />
          </div>
          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label"><span>Base URL</span><span class="behavior-desc">OpenAI 填兼容端点；DashScope 请填写完整的 /api/v1/services/aigc/multimodal-generation/generation 地址</span></div>
            <input type="text" class="behavior-input" style="width:280px" v-model="voiceDraft.base_url" placeholder="https://…/api/v1/services/aigc/multimodal-generation/generation" />
          </div>
          <div v-if="voiceDraft.api_format === 'dashscope'" class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label"><span>百炼产品线</span><span class="behavior-desc">选择后会自动填入适合的模型示例和请求适配器</span></div>
            <AdminSelect :model-value="voiceDraft.dashscope_service || 'qwen3-asr'"
                         :options="VOICE_DASHSCOPE_SERVICES"
                         @update:model-value="setDashscopeService" />
          </div>
          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label"><span>API 格式</span><span class="behavior-desc">OpenAI 兼容：chat + input_audio；百炼 DashScope：原生多模态 HTTP</span></div>
            <div style="display:flex;gap:8px;justify-content:flex-end;align-items:center;">
              <button v-for="af in VOICE_API_FORMATS" :key="af.value" type="button" class="btn-ghost"
                      :style="voiceDraft.api_format === af.value ? 'border-color:var(--color-primary);color:var(--color-primary)' : ''"
                      @click="voiceDraft.api_format = af.value">{{ af.label }}</button>
            </div>
          </div>
          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label"><span>API Key<span v-if="configStore.secretSet.voiceApiKey" style="margin-left:6px;color:var(--color-primary);font-size:11px;font-weight:600">· 已配置 ✓</span></span><span class="behavior-desc">已存的 Key 出于安全不回显；留空＝保留不变，要换填新值覆盖</span></div>
            <input type="password" class="behavior-input" style="width:280px" v-model="voiceDraft.api_key"
                   :placeholder="configStore.secretSet.voiceApiKey ? '已配置，留空＝不修改' : '填入语音模型 API Key'" />
          </div>
        </div>

        <div class="card-actions">
          <span class="save-hint" :class="{ error: !!voiceError }">
            <template v-if="voiceSaved"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 6l2.5 2.5 5.5-5"/></svg>已保存</template>
            <template v-else-if="voiceError">{{ voiceError }}</template>
            <template v-else-if="voiceTestMsg">{{ voiceTestMsg }}</template>
          </span>
          <button class="btn-ghost" @click="resetVoice">撤销修改</button>
          <button class="btn-ghost" :class="{ loading: voiceTesting }" :disabled="voiceTesting" @click="testVoice">
            {{ voiceTesting ? '测试中…' : '测试接入' }}
          </button>
          <button class="btn-primary" :class="{ loading: voiceSaving }" :disabled="voiceSaving" @click="saveVoice">
            <svg v-if="voiceSaving" class="spin-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 1v2M6 9v2M1 6h2M9 6h2"/></svg>
            {{ voiceSaving ? '保存中…' : '保存' }}
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
            <div class="behavior-label"><span>提供方 provider</span><span class="behavior-desc">选择服务商；通用兼容用于其他 OpenAI 兼容端点</span></div>
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
            <input type="number" class="behavior-input" style="width:280px" v-model.number="embeddingDraft.dimensions" placeholder="0（模型默认）" />
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
            <template v-if="embeddingSaved"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 6l2.5 2.5 5.5-5"/></svg>已保存</template>
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

      <!-- ── 决策轨迹（只读调试）── -->
      <TracePanel v-if="activeTab === 'trace'" />

    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import Checkbox from '@/components/common/Checkbox.vue'
import { useRoute } from 'vue-router'
import LocalCapabilityOverrides from './components/LocalCapabilityOverrides.vue'
import CapabilityCatalogPanel from './capabilities/components/CapabilityCatalogPanel.vue'
import TracePanel from './observability/components/TracePanel.vue'
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

const configStore = useConfigStore()
const adminStore  = useAdminStore()
const route = useRoute()
const standaloneMode = computed(() => route.path === '/agent-behavior' ? 'behavior' : route.path === '/agent-usage' ? 'usage' : '')
const runtimeConfig = useAgentRuntimeConfig()
const { agentDraft, behaviorSaving, behaviorSaved, behaviorError, resetBehavior, saveBehavior, generalSearchDraft, ragIndexTtlDays, deepResearchDraft, similarImageDraft, generalSearchSaving, generalSearchSaved, generalSearchError, deepResearchSaving, deepResearchSaved, deepResearchError, deepResearchTest, similarImageSaving, similarImageSaved, similarImageError, resetGeneralSearch, resetDeepResearch, resetSimilarImageSearch, voiceDraft, voiceSaving, voiceSaved, voiceError, voiceTesting, voiceTestMsg, VOICE_API_FORMATS, VOICE_DASHSCOPE_SERVICES, resetVoice, setDashscopeService, saveVoice, testVoice, searchTest, testSearch, testDeepResearch, saveDeepResearch, saveSearch } = runtimeConfig
const llmPresets = useLlmPresets(adminStore, configStore, agentDraft)
const { presets, activePresetId, strategy, poolMode, presetsLoading, llmMsg, llmMsgError, testingId, activatingId, probingId, probingDim, showMsg, fetchPresets, setStrategy, setPoolMode, saveConcurrency, activatePreset, deletePreset, testPreset } = llmPresets

const tabs = [
  { key: 'llm',      label: 'LLM 配置' },
  { key: 'trace',    label: '决策轨迹' },
  { key: 'prompts',  label: '系统提示词' },
]
const activeTab = ref(standaloneMode.value || 'llm')
const behaviorTabs = [
  { key: 'runtime', label: '运行行为' },
  { key: 'search', label: '搜索与图片' },
  { key: 'voice', label: '语音识别' },
  { key: 'capabilities', label: '能力目录' },
  { key: 'labels', label: '状态命名' },
]
const behaviorTab = ref('runtime')

function switchTab(key: string) {
  activeTab.value = key
  if (key === 'llm'     && presets.value.length === 0) fetchPresets()
}

// ── LLM 预设 ──────────────────────────────────────────────────────────────
const PROVIDERS = [
  { key: 'openai',    label: 'OpenAI 兼容', base_url: 'https://api.openai.com/v1',                          model: 'gpt-4o' },
  { key: 'anthropic', label: 'Anthropic',   base_url: 'https://api.anthropic.com/v1',                       model: 'claude-opus-4-8' },
  { key: 'qwen',      label: 'DashScope(百炼)', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-max' },
  { key: 'glm',       label: '智谱 GLM',       base_url: 'https://open.bigmodel.cn/api/paas/v4',              model: 'glm-5.2' },
  { key: 'deepseek',  label: 'DeepSeek',    base_url: 'https://api.deepseek.com',                           model: 'deepseek-v4-flash-vision-exp' },
  { key: 'minimax',   label: 'MiniMax',     base_url: 'https://api.minimaxi.com/anthropic',                 model: 'MiniMax-M3' },
  { key: 'mimo',      label: 'MiMo (小米)',  base_url: 'https://api.xiaomimimo.com/v1',                       model: 'mimo-mono.5' },
  { key: 'ollama',    label: 'Ollama',      base_url: 'http://127.0.0.1:11434/v1',                          model: 'qwen3:8b' },
  { key: 'local',     label: '本地兼容服务', base_url: '',                                                   model: '' },
]

const LOCAL_RUNTIMES = [
  { key: 'llama.cpp', label: 'llama.cpp' },
  { key: 'vllm', label: 'vLLM' },
  { key: 'other', label: '其它兼容服务' },
]
// MiMo 同时提供 OpenAI / Anthropic 两套兼容 API，按预设选格式（影响后端走哪条通道）
const API_FORMATS = [
  { key: 'openai',    label: 'OpenAI 格式' },
  { key: 'anthropic', label: 'Anthropic 格式' },
]

const capabilityProbeLoading = ref(false)
const capabilityProbeResult = ref<Record<string, { status?: string; detail?: string }>>({})

// 多模态三维度：图片→vision，视频→vision_video，音频→vision_audio
const visionDims = [
  { key: 'image', label: '图片', hint: '用户发的图片直接给模型「看」' },
  { key: 'video', label: '视频', hint: '用户发的视频直接给模型「看」' },
  { key: 'audio', label: '音频', hint: '用户发的音频直接给模型「听」' },
]
const DEEPSEEK_EFFORTS = [
  { key: '', label: '默认' },
  { key: 'low', label: '低' },
  { key: 'high', label: '高' },
  { key: 'max', label: '最大' },
]
const IMAGE_DETAIL_LEVELS = [
  { key: 'auto', label: '自动' },
  { key: 'low', label: '低' },
  { key: 'high', label: '高' },
  { key: 'original', label: '原图' },
]

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
    if (!res.ok) throw new Error('更新失败')
    p.in_pool = next
  } catch (e) {
    showMsg('更新分流失败：' + (e instanceof Error ? e.message : String(e)), true)
  }
}

function openNewPreset() {
  editIsNew.value  = true
  editTarget.value = { name: '', provider: 'openai', api_key: '', base_url: PROVIDERS[0].base_url, model: PROVIDERS[0].model, max_tokens: 4000, temperature: 0.7, context_tokens: 120000, thinking: 'disabled', reasoning_effort: '', vision: false, vision_detail: 'auto', vision_video: false, vision_audio: false, api_format: '', ollama_mode: 'local', ollama_api_mode: 'native', ollama_keep_alive: '5m', deployment_mode: 'cloud', local_runtime: 'other', capability_overrides: {} }
  editError.value  = ''
  modelOptions.value = []
  modelListError.value = ''
  modelMenuOpen.value = false
  capabilityProbeResult.value = {}
}

function openEditPreset(p: LlmPresetRecord) {
  editIsNew.value  = false
  editTarget.value = { ...p, api_key: '', vision_detail: p.vision_detail || 'auto', ollama_mode: p.ollama_mode || 'local', ollama_api_mode: p.ollama_api_mode || 'native', ollama_keep_alive: p.ollama_keep_alive || '5m', deployment_mode: p.deployment_mode || (p.provider === 'local' ? 'local' : 'cloud'), local_runtime: p.local_runtime || 'other', capability_overrides: p.capability_overrides || {} } as unknown as LlmPresetDraft
  editError.value  = ''
  modelOptions.value = []
  modelListError.value = ''
  modelMenuOpen.value = false
  capabilityProbeResult.value = p.capability_probe || {}
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
    if (!res.ok) throw new Error(data.detail || '能力检测失败')
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
    editError.value = e instanceof Error ? e.message : '能力检测失败'
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
    if (!res.ok) throw new Error(data.detail || '获取模型列表失败')
    modelOptions.value = Array.isArray(data.models) ? data.models : []
    if (!modelOptions.value.length) modelListError.value = '服务商没有返回可用模型，请手动输入'
  } catch (error) {
    modelOptions.value = []
    modelListError.value = error instanceof Error ? error.message : '获取模型列表失败'
  } finally {
    modelListLoading.value = false
  }
}

function setEditProvider(key: string) {
  const target = editTarget.value
  const pv = PROVIDERS.find(p => p.key === key)
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
      throw new Error(err.detail || `保存失败（${res.status}）`)
    }
    editTarget.value = null
    await fetchPresets()
    showMsg('已保存')
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
      const label = visionDims.find(d => d.key === dim)?.label || dim
      if (data.supported === true)       showMsg(`✅ ${label}：支持，已开启`)
      else if (data.supported === false) showMsg(`${label}：不支持，已设为关闭：${data.detail}`, true)
      else                               showMsg(`${label}：测不准：${data.detail}`, true)
      if (data.supported === true || data.supported === false) {
        const field = dim === 'image' ? 'vision' : 'vision_' + dim
        target![field] = data.supported
      }
    } else {
      // 全维度（卡片）
      const results = data.results || {}
      const ok: string[] = [], no: string[] = [], unk: string[] = []
      for (const d of visionDims) {
        const r = results[d.key]
        if (!r) continue
        if (r.supported === true) ok.push(d.label)
        else if (r.supported === false) no.push(d.label)
        else unk.push(d.label)
      }
      const parts: string[] = []
      if (ok.length) parts.push(`支持：${ok.join('、')}`)
      if (no.length) parts.push(`不支持：${no.join('、')}`)
      if (unk.length) parts.push(`测不准：${unk.join('、')}`)
      showMsg(parts.length ? `检测完成 — ${parts.join('；')}` : '检测完成，未返回结果')
    }
    await fetchPresets()   // 刷新卡片徽章
  } catch (e) {
    showMsg('检测失败：' + (e instanceof Error ? e.message : String(e)), true)
  } finally {
    probingId.value = null
    probingDim.value = null
  }
}

// ── 初始化 ────────────────────────────────────────────────────────────────
onMounted(async () => {
  await configStore.fetchConfig()
  Object.assign(agentDraft, configStore.cfg.agent)
  resetGeneralSearch()
  resetSimilarImageSearch()
  Object.assign(voiceDraft, configStore.cfg.voice)
  fetchPresets()
})

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
  background: rgba(0,0,0,0.2);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 13px; font-weight: 600;
  color: rgba(255,255,255,0.8);
  text-align: center; outline: none;
  transition: border-color 0.15s;
}
.behavior-input:focus { border-color: rgba(123,127,178,0.4); }


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
.strategy-select { display: flex; align-items: center; gap: 6px; font-size: 12px; color: rgba(255,255,255,0.5); }
.pca-btn--pool-on { background: rgba(123,127,178,0.22); color: rgba(180,176,224,1); }
.conc-input {
  width: 52px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.14);
  border-radius: 8px; color: rgba(255,255,255,0.85); font-size: 12px; padding: 5px 8px; outline: none;
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
  margin-top: 12px; padding: 10px 14px; border-radius: 10px;
  font-size: 13px; color: #5ab899;
  background: rgba(90,184,153,0.1); border: 1px solid rgba(90,184,153,0.2);
}
.llm-msg--error {
  color: #e07878;
  background: rgba(220,100,100,0.1); border-color: rgba(220,100,100,0.2);
}


</style>
