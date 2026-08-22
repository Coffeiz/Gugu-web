<template>
  <div class="agent-page">

    <div class="page-header">
      <div class="page-title-block">
        <h2 class="page-title">Agent 配置</h2>
        <p class="page-desc">管理 LLM 连接、系统提示词与行为参数</p>
      </div>
    </div>

    <!-- 标签栏 -->
    <div class="tab-bar">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-btn"
        :class="{ active: activeTab === tab.key }"
        :data-label="tab.label"
        @click="switchTab(tab.key)"
      >{{ tab.label }}</button>
    </div>

    <div class="panels-wrap">

      <!-- ── 能力目录 ── -->
      <section v-if="activeTab === 'capabilities'" class="config-card capability-catalog-card">
        <div class="capability-catalog-head">
          <div>
            <h3 class="presets-title">能力目录</h3>
            <p class="presets-desc">来自 Tool / Skill Registry 的只读目录；完整 Schema 和正文只在 Agent 请求中按需注入。</p>
          </div>
          <button type="button" class="pca-btn" :disabled="capabilityCatalogLoading" @click="fetchCapabilityCatalog">
            {{ capabilityCatalogLoading ? '刷新中…' : '刷新目录' }}
          </button>
        </div>
        <div v-if="capabilityCatalogError" class="llm-msg llm-msg--error">{{ capabilityCatalogError }}</div>
        <div v-else-if="capabilityCatalogLoading && !capabilityCatalog" class="presets-loading">加载中…</div>
        <template v-else-if="capabilityCatalog">
          <div class="capability-catalog-summary">
            <span>工具 {{ capabilityCatalog.tools.length }}</span>
            <span>Skill {{ capabilityCatalog.skills.length }}</span>
            <span v-if="capabilityCatalog.diagnostics.length" class="capability-catalog-warning">
              诊断 {{ capabilityCatalog.diagnostics.length }} 项
            </span>
          </div>
          <div class="capability-catalog-group">
            <h4>工具</h4>
            <div class="capability-catalog-grid">
              <div v-for="item in capabilityCatalog.tools" :key="item.name" class="capability-catalog-item">
                <div class="capability-catalog-item-head">
                  <code>{{ item.name }}</code>
                  <span>{{ item.category || '未分类' }}</span>
                </div>
                <p>{{ item.description_short }}</p>
                <small>{{ item.permissions.length ? `权限：${item.permissions.join('、')}` : '无额外权限声明' }}</small>
              </div>
            </div>
          </div>
          <div class="capability-catalog-group">
            <h4>Skill</h4>
            <div class="capability-catalog-grid">
              <div v-for="item in capabilityCatalog.skills" :key="item.name" class="capability-catalog-item">
                <div class="capability-catalog-item-head">
                  <code>{{ item.name }}</code>
                  <span>{{ item.category || '未分类' }}</span>
                </div>
                <p>{{ item.description_short }}</p>
                <small>{{ item.related_tools.length ? `关联工具：${item.related_tools.join('、')}` : '未声明关联工具' }}</small>
              </div>
            </div>
          </div>
        </template>
      </section>

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
                <span v-if="p.thinking === 'adaptive'" class="preset-meta-item preset-meta-think"><PhBrain :size="11" weight="bold" />思考</span>
                <span v-if="p.vision" class="preset-meta-item preset-meta-vision"><PhEye :size="11" weight="bold" />图片</span>
                <span v-if="p.vision_video" class="preset-meta-item preset-meta-vision"><PhVideo :size="11" weight="bold" />视频</span>
                <span v-if="p.vision_audio" class="preset-meta-item preset-meta-vision"><PhMicrophone :size="11" weight="bold" />音频</span>
                <span class="preset-key" :title="p.api_key || '未设置 Key'">{{ p.api_key || '未设置 Key' }}</span>
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

      <!-- 新建 / 编辑预设 Modal -->
      <Teleport to="body">
        <div
          v-if="editTarget"
          class="modal-mask"
          @mousedown.self="editMaskDown = true"
          @mouseup.self="editMaskDown && (editTarget = null); editMaskDown = false"
        >
          <div class="modal-box">
            <h4 class="modal-title">{{ editIsNew ? '新建预设' : '编辑预设' }}</h4>

            <div class="modal-field">
              <label>预设名称</label>
              <input v-model="editTarget.name" placeholder="MiniMax 主力" class="modal-input" />
            </div>

            <div class="modal-field">
              <label>Provider</label>
              <div class="toggle-group" style="margin-bottom:0">
                <button v-for="pv in PROVIDERS" :key="pv.key"
                  class="toggle-btn" :class="{ active: editTarget.provider === pv.key }"
                  :data-label="pv.label"
                  @click="setEditProvider(pv.key)">{{ pv.label }}</button>
              </div>
            </div>

            <div v-if="editTarget.provider === 'local'" class="modal-field">
              <label>本地运行时</label>
              <div class="toggle-group" style="margin-bottom:0">
                <button v-for="runtime in LOCAL_RUNTIMES" :key="runtime.key" type="button" class="toggle-btn"
                  :class="{ active: (editTarget.local_runtime || 'other') === runtime.key }"
                  @click="editTarget.local_runtime = runtime.key">{{ runtime.label }}</button>
              </div>
              <div class="modal-hint">统一使用 OpenAI 兼容接口；工具、结构化输出等能力需检测或人工启用。</div>
            </div>

            <div v-if="editTarget.provider === 'ollama'" class="modal-field">
              <label>连接方式</label>
              <div class="toggle-group" style="margin-bottom:0">
                <button type="button" class="toggle-btn"
                  :class="{ active: (editTarget.ollama_mode || 'local') === 'local' }"
                  @click="setOllamaMode('local')">本地 Ollama</button>
                <button type="button" class="toggle-btn"
                  :class="{ active: editTarget.ollama_mode === 'cloud' }"
                  @click="setOllamaMode('cloud')">Ollama Cloud</button>
              </div>
              <div class="modal-hint">
                本地默认连接当前后端所在机器的 Ollama；云端需要填写 Ollama Cloud API Key。
              </div>
              <label style="margin-top:10px">接口模式</label>
              <div class="toggle-group" style="margin-bottom:0">
                <button type="button" class="toggle-btn"
                  :class="{ active: (editTarget.ollama_api_mode || 'native') === 'native' }"
                  @click="editTarget.ollama_api_mode = 'native'">Ollama 原生</button>
                <button type="button" class="toggle-btn"
                  :class="{ active: editTarget.ollama_api_mode === 'openai' }"
                  @click="editTarget.ollama_api_mode = 'openai'">OpenAI 兼容</button>
              </div>
              <div class="modal-hint">
                原生模式使用 <code>/api/chat</code>，支持原生思考、工具调用和模型驻留；兼容模式使用 <code>/v1</code>。
              </div>
              <div class="modal-hint ollama-mode-warning">
                原生模式只适用于已安装在 Ollama 中的模型（例如 <code>qwen3:8b</code>）。
                如果使用 <code>minimax-m3</code> 等外部模型或 OpenAI 兼容服务，请切换为「OpenAI 兼容」并填写对应的 <code>/v1</code> 地址。
              </div>
              <div v-if="(editTarget.ollama_api_mode || 'native') === 'native'" class="modal-field">
                <label>模型驻留</label>
                <input v-model="editTarget.ollama_keep_alive" class="modal-input" placeholder="5m" />
              </div>
            </div>

            <div class="modal-field">
              <label>{{ editTarget.provider === 'ollama' && (editTarget.ollama_mode || 'local') === 'local' ? 'API Key（可选）' : 'API Key' }}</label>
              <input v-model="editTarget.api_key" type="password" autocomplete="new-password"
                :placeholder="editTarget.provider === 'ollama' && (editTarget.ollama_mode || 'local') === 'local' ? '本地 Ollama 通常留空' : '留空表示不修改'" class="modal-input" />
            </div>

            <div class="modal-field">
              <label>Base URL</label>
              <input v-model="editTarget.base_url" :placeholder="editTarget.provider === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'https://…'" class="modal-input" />
              <div v-if="editTarget.provider === 'ollama'" class="modal-hint">
                本地：<code>http://127.0.0.1:11434/v1</code>；云端：<code>https://ollama.com/v1</code>。地址指向运行 Gugu 后端的机器。
              </div>
              <div v-if="editTarget.provider === 'qwen'" class="modal-hint">
                百炼建议使用业务空间专属域名：<code>https://&#123;WorkspaceId&#125;.cn-beijing.maas.aliyuncs.com/compatible-mode/v1</code>（WorkspaceId 在控制台业务空间详情页查看）；通用域名 dashscope.aliyuncs.com 仍可用
              </div>
            </div>

            <div class="modal-field">
              <label>模型名称</label>
              <div class="model-picker" @focusout="closeModelMenuSoon">
                <div class="model-picker-row">
                  <input v-model="editTarget.model" placeholder="qwen-max" class="modal-input"
                    @focus="modelMenuOpen = true" />
                  <button type="button" class="model-fetch-btn" :disabled="modelListLoading"
                    title="从服务商获取模型列表"
                    @mousedown.prevent @click="fetchModelList">
                    {{ modelListLoading ? '获取中…' : '获取列表' }}
                  </button>
                </div>
                <div v-if="modelMenuOpen" class="model-options" @mousedown.stop>
                  <div v-if="modelListError" class="model-option-hint error">{{ modelListError }}</div>
                  <div v-else-if="!modelOptions.length" class="model-option-hint">
                    点击“获取列表”加载可用模型
                  </div>
                  <button v-for="model in filteredModelOptions" :key="model" type="button" class="model-option"
                    @mousedown.prevent="selectModel(model)">{{ model }}</button>
                </div>
              </div>
            </div>

            <div class="modal-field" v-if="editTarget.provider === 'mimo'">
              <label>API 格式 <span class="thinking-hint" style="font-weight:400">Anthropic 格式可用思考块 / 缓存 / 看库内图</span></label>
              <div class="api-format-grid">
                <button v-for="f in API_FORMATS" :key="f.key" type="button"
                  class="toggle-btn" :class="{ active: (editTarget.api_format || 'openai') === f.key }"
                  @click="pickApiFormat(f.key)">{{ f.label }}</button>
              </div>
            </div>

            <div class="modal-field-row">
              <div class="modal-field">
                <label>最大输出 Tokens</label>
                <input v-model.number="editTarget.max_tokens" type="number" min="100" max="32000" step="100" class="modal-input" />
              </div>
              <div class="modal-field">
                <label>发散度 Temperature</label>
                <input v-model.number="editTarget.temperature" type="number" min="0" max="2" step="0.05" class="modal-input" />
              </div>
            </div>

            <div class="modal-field">
              <label>上下文历史 Tokens</label>
              <input v-model.number="editTarget.context_tokens" type="number" min="500" max="200000" step="500" class="modal-input" />
            </div>

            <div class="modal-field modal-field--row">
              <div class="thinking-label">
                <span>深度思考</span>
                <span class="thinking-hint">MiniMax M3 / Anthropic / mimo / DeepSeek（adaptive 模式）</span>
              </div>
              <button
                class="toggle-switch"
                :class="{ on: editTarget.thinking === 'adaptive' }"
                @click="editTarget.thinking = editTarget.thinking === 'adaptive' ? 'disabled' : 'adaptive'"
              >
                <span class="toggle-knob" />
              </button>
            </div>

            <div class="modal-field modal-field--row" v-if="editTarget.provider === 'deepseek'">
              <div class="thinking-label">
                <span>思考强度</span>
                <span class="thinking-hint">思考开启时生效；关闭思考时先保存选择</span>
              </div>
              <div style="display:flex; gap:6px;">
                <button v-for="effort in DEEPSEEK_EFFORTS" :key="effort.key" type="button" class="toggle-btn"
                  :disabled="editTarget.thinking !== 'adaptive'"
                  :class="{ active: editTarget.reasoning_effort === effort.key || (!editTarget.reasoning_effort && effort.key === '') }"
                  @click="editTarget.reasoning_effort = effort.key">{{ effort.label }}</button>
              </div>
            </div>

            <div class="modal-field modal-field--row" v-if="editTarget.provider === 'deepseek'">
              <div class="thinking-label">
                <span>图片细节级别</span>
                <span class="thinking-hint">DeepSeek Vision 的 image_url.detail；auto 自动选择，通常等价于 original</span>
              </div>
              <div style="display:flex; gap:6px;">
                <button v-for="detail in IMAGE_DETAIL_LEVELS" :key="detail.key" type="button" class="toggle-btn"
                  :class="{ active: (editTarget.vision_detail || 'auto') === detail.key }"
                  @click="editTarget.vision_detail = detail.key">{{ detail.label }}</button>
              </div>
            </div>

            <div class="modal-field modal-field--row">
              <div class="thinking-label">
                <span>多模态能力</span>
                <span class="thinking-hint">图片/视频/音频分别开关；点「检测」自动判定该维度是否支持，成功后自动开启</span>
              </div>
            </div>

            <div v-if="editTarget.provider === 'local'" class="modal-field">
              <div class="thinking-label">
                <span>本地能力覆盖</span>
                <span class="thinking-hint">仅覆盖已确认的能力；留空表示使用默认声明</span>
              </div>
              <div class="capability-overrides">
                <label v-for="cap in LOCAL_CAPABILITIES" :key="cap.key" class="capability-override">
                  <input type="checkbox" :checked="editTarget.capability_overrides?.[cap.key] === true"
                    @change="setCapabilityOverride(cap.key, ($event.target as HTMLInputElement).checked)" />
                  {{ cap.label }}
                </label>
              </div>
              <button type="button" class="pca-btn pca-btn--sm" :disabled="editIsNew || capabilityProbeLoading"
                @click="probeCapabilities(editTarget.id)">
                {{ capabilityProbeLoading ? '检测中…' : '检测本地能力' }}
              </button>
              <div v-if="editTarget.capability_checked_at" class="modal-hint">
                最近检测：{{ editTarget.capability_checked_at }}
              </div>
            </div>

            <div class="modal-field modal-field--row" v-for="dim in visionDims" :key="dim.key">
              <div class="thinking-label">
                <span>{{ dim.label }}</span>
                <span class="thinking-hint">{{ dim.hint }}</span>
              </div>
              <div style="display:flex; align-items:center; gap:8px;">
                <button
                  type="button"
                  class="pca-btn pca-btn--sm"
                  :class="{ 'pca-btn--testing': probingDim === dim.key }"
                  :disabled="editIsNew || (probingDim !== null && probingDim !== dim.key)"
                  :title="editIsNew ? '先保存预设再检测' : ''"
                  @click="probeVision(editTarget.id, dim.key)"
                >{{ probingDim === dim.key ? '检测中…' : '检测' }}</button>
                <button
                  class="toggle-switch"
                  :class="{ on: editTarget[dim.key === 'image' ? 'vision' : 'vision_' + dim.key] }"
                  @click="editTarget[dim.key === 'image' ? 'vision' : 'vision_' + dim.key] = !editTarget[dim.key === 'image' ? 'vision' : 'vision_' + dim.key]"
                >
                  <span class="toggle-knob" />
                </button>
              </div>
            </div>

            <div class="modal-actions">
              <span class="save-hint" :class="{ error: !!editError }">{{ editError }}</span>
              <button class="btn-ghost" @click="editTarget = null">取消</button>
              <button class="btn-primary" :disabled="editSaving" @click="savePreset">
                <svg v-if="editSaving" class="spin-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 1v2M6 9v2M1 6h2M9 6h2"/></svg>
                {{ editSaving ? '保存中…' : '保存' }}
              </button>
            </div>
          </div>
        </div>
      </Teleport>


      <!-- ── 系统提示词 ── -->
      <section v-if="activeTab === 'prompts'" class="config-card prompts-card">
        <div class="card-head">
          <div class="card-icon" style="--ic:rgba(122,184,200,0.14);--stroke:#7ab8c8">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 6h12M4 10h8M4 14h6"/>
            </svg>
          </div>
          <div class="card-title-block">
            <h3>系统提示词</h3>
            <p>各 Profile 的 Prompt 模板，支持占位符，保存后热更新</p>
          </div>
          <div class="profile-switcher">
            <button
              v-for="p in profiles"
              :key="p.profile"
              class="toggle-btn"
              :class="{ active: activeProfile === p.profile }"
              :data-label="p.profile"
              @click="switchProfile(p.profile)"
            >{{ (({persona:'人格', skills:'工具准则', policy:'内容政策', reflection:'记忆反思', compress:'记忆压缩'}) as Record<string,string>)[p.profile] || p.profile }}</button>
          </div>
        </div>

        <div v-if="activeProfile === 'persona'" class="persona-caution"
          style="margin:0 0 12px;padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.6;min-height:62px;box-sizing:border-box;
                 background:rgba(214,138,90,0.12);border:1px solid rgba(214,138,90,0.3);color:#b07043">
          ⚠️ 这是咕咕的<strong>人格设定</strong>，所有对话共享。谨慎修改 —— 会直接改变咕咕的性格、主动性、对话模式与说话方式。
        </div>

        <div v-if="activeProfile === 'skills'" class="persona-caution"
          style="margin:0 0 12px;padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.6;min-height:62px;box-sizing:border-box;
                 background:rgba(123,127,178,0.12);border:1px solid rgba(123,127,178,0.3);color:#5b5f96">
          🛠️ 这是<strong>工具使用准则</strong>（Execution Policy），紧跟人格注入、所有对话共享。决定咕咕何时该动手、动几下、别重复验证/查询。越短越好用，改它直接影响咕咕调工具的行为模式。
        </div>

        <div v-if="activeProfile === 'policy'" class="persona-caution"
          style="margin:0 0 12px;padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.6;min-height:62px;box-sizing:border-box;
                 background:rgba(214,90,90,0.12);border:1px solid rgba(214,90,90,0.3);color:#b04343">
          🚫 这是<strong>内容政策（红线）</strong>，所有对话共享。定义咕咕不参与的话题（政治、色情等）和专业领域免责。以后加新红线就在这里加一行。
        </div>

        <div v-if="activeProfile === 'reflection'" class="persona-caution"
          style="margin:0 0 12px;padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.6;min-height:62px;box-sizing:border-box;
                 background:rgba(214,138,90,0.12);border:1px solid rgba(214,138,90,0.3);color:#b07043">
          ⚠️ 这是<strong>记忆反思提炼词</strong>，决定咕咕每次对话后从中记住什么。改它会影响记忆质量；需保持输出 JSON 格式 <code>{"profile_add":[...],"pattern_add":[...],"daily":"..."}</code>。
        </div>

        <div v-if="activeProfile === 'compress'" class="persona-caution"
          style="margin:0 0 12px;padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.6;min-height:62px;box-sizing:border-box;
                 background:rgba(214,138,90,0.12);border:1px solid rgba(214,138,90,0.3);color:#b07043">
          ⚠️ 这是<strong>记忆压缩提炼词</strong>，决定老的近期记忆怎么沉淀进长期记忆。改它会影响长期记忆质量；需保持输出 JSON 格式 <code>{"memory":"..."}</code>。
        </div>

        <div class="prompt-editor-wrap">
          <textarea
            class="prompt-textarea scroll-surface scroll-surface--editor"
            v-model="promptContent"
            placeholder="输入系统提示词模板…"
            spellcheck="false"
          />
          <div class="placeholder-panel">
            <div class="placeholder-title">可用占位符</div>
            <div
              v-for="ph in placeholders"
              :key="ph.key"
              class="placeholder-item"
              @click="insertPlaceholder(ph.key)"
              title="点击插入"
            >
              <code>{{ ph.key }}</code>
              <span>{{ ph.desc }}</span>
            </div>
          </div>
        </div>

        <div class="card-actions">
          <span class="save-hint" :class="{ error: !!promptError, muted: !promptSaved && !promptError }">
            <template v-if="promptSaved"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 6l2.5 2.5 5.5-5"/></svg>已保存</template>
            <template v-else-if="promptError">{{ promptError }}</template>
            <template v-else>修改后点击保存即时生效，无需重启</template>
          </span>
          <button class="btn-primary" :class="{ loading: promptSaving }" :disabled="promptSaving" @click="savePrompt">
            <svg v-if="promptSaving" class="spin-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 1v2M6 9v2M1 6h2M9 6h2"/></svg>
            {{ promptSaving ? '保存中…' : '保存提示词' }}
          </button>
        </div>
      </section>

      <!-- ── 行为配置 ── -->
      <section v-if="activeTab === 'behavior'" class="config-card">
        <div class="card-head">
          <div class="card-icon" style="--ic:rgba(123,127,178,0.15);--stroke:#7b7fb2">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round">
              <path d="M10 2a8 8 0 100 16A8 8 0 0010 2z"/>
              <path d="M10 6v4l3 3"/>
            </svg>
          </div>
          <div class="card-title-block">
            <h3>行为配置</h3>
            <p>记忆系统参数（记忆系统实装后生效）</p>
          </div>
        </div>

        <div class="behavior-grid">
          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label">
              <span>Shell 工具总开关</span>
              <span class="behavior-desc">默认关闭。开启后仅允许本地 Admin 进入后续 Shell 能力；用户开关、工作区和沙盒仍需分别满足。</span>
            </div>
            <button
              class="toggle-switch"
              :class="{ on: agentDraft.shell_enabled }"
              @click="agentDraft.shell_enabled = !agentDraft.shell_enabled; saveBehavior()"
            >
              <span class="toggle-knob" />
            </button>
          </div>

          <div class="behavior-item">
            <div class="behavior-label">
              <span>记忆系统</span>
              <span class="behavior-desc">开启后 Agent 将自动从对话中提炼记忆</span>
            </div>
            <button
              class="toggle-switch"
              :class="{ on: agentDraft.memory_enabled }"
              @click="agentDraft.memory_enabled = !agentDraft.memory_enabled; saveBehavior()"
            >
              <span class="toggle-knob" />
            </button>
          </div>

          <div class="behavior-item">
            <div class="behavior-label">
              <span>对话历史压缩</span>
              <span class="behavior-desc">超长会话把旧消息总结成摘要省 token；关闭后只截断不摘要</span>
            </div>
            <button
              class="toggle-switch"
              :class="{ on: agentDraft.conv_compress_enabled }"
              @click="agentDraft.conv_compress_enabled = !agentDraft.conv_compress_enabled; saveBehavior()"
            >
              <span class="toggle-knob" />
            </button>
          </div>

          <div class="behavior-item">
            <div class="behavior-label">
              <span>IM 慢工具进度声明</span>
              <span class="behavior-desc">多步工具循环期间先发一句"我去查一下"再执行，减少 IM 非流式的长时间沉默感；文案来自工具自身登记的固定文案，不是模型现场生成；只在 IM 生效，网页不受影响</span>
            </div>
            <button
              class="toggle-switch"
              :class="{ on: agentDraft.im_progress_announce_enabled }"
              @click="agentDraft.im_progress_announce_enabled = !agentDraft.im_progress_announce_enabled; saveBehavior()"
            >
              <span class="toggle-knob" />
            </button>
          </div>

          <div class="behavior-item">
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

          <div class="behavior-item">
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

          <div class="behavior-item">
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
      <section v-if="activeTab === 'behavior'" class="config-card">
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
            <p>通用搜索走自建 SearXNG（免费、不计配额），深度研究 / 总结走 Tavily（有每日次数上限，在「配额管理」设置）</p>
          </div>
        </div>

        <div class="behavior-grid">
          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label">
              <span>SearXNG 地址（通用搜索 web_search）</span>
              <span class="behavior-desc">自建 SearXNG 实例地址，留空=禁用通用搜索、全部走 Tavily。同机填 http://127.0.0.1:端口，内网/1Panel 部署填对应内网 IP:端口</span>
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
              <span class="behavior-desc">逗号分隔。国内服务器一般只有这几个可达；google/bing 会超时</span>
            </div>
            <input
              type="text"
              class="behavior-input"
              style="width: 280px;"
              v-model="generalSearchDraft.searxng_engines"
              placeholder="sogou,quark,360search"
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

          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label">
              <span>Tavily API Key（深度研究 deep_research）</span>
              <span class="behavior-desc">留空表示不修改；清空并保存不会删除已存的 key</span>
            </div>
            <div style="display:flex; align-items:center; gap:10px; justify-content:flex-end; min-width:0;">
              <span v-if="searchTest.tavily.msg" :title="searchTest.tavily.msg"
                    :style="{ color: searchTest.tavily.ok ? '#4caf7d' : '#e07070', fontSize:'12px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', minWidth:0 }">
                {{ searchTest.tavily.msg }}
              </span>
              <button class="btn-ghost" style="flex-shrink:0;" :disabled="searchTest.tavily.loading" @click="testSearch('tavily')">
                {{ searchTest.tavily.loading ? '测试中…' : '测试' }}
              </button>
              <input
                type="password"
                class="behavior-input"
                style="width: 280px; flex-shrink:0;"
                v-model="generalSearchDraft.tavily_api_key"
                placeholder="tvly-… （留空表示不修改）"
                autocomplete="new-password"
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

      <!-- ── 相似图搜索 ── -->
      <section v-if="activeTab === 'behavior'" class="config-card">
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
              <input type="checkbox" v-model="similarImageDraft.similar_image_enabled" title="启用百度千帆相似图搜索" />
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
      <section v-if="activeTab === 'behavior'" class="config-card">
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

      <!-- ── 向量 Embedding 模型 ── -->
      <section v-if="activeTab === 'behavior'" class="config-card">
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
            <button
              class="toggle-switch"
              :class="{ on: embeddingDraft.enabled }"
              @click="embeddingDraft.enabled = !embeddingDraft.enabled"
            >
              <span class="toggle-knob" />
            </button>
          </div>
          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label"><span>多模态 Embedding</span><span class="behavior-desc">百炼填写 <code>qwen3-vl-embedding</code>；开启后供图片/视频向量调用使用，不改变现有文本记忆索引</span></div>
            <button
              class="toggle-switch"
              :class="{ on: embeddingDraft.multimodal }"
              @click="embeddingDraft.multimodal = !embeddingDraft.multimodal"
            >
              <span class="toggle-knob" />
            </button>
          </div>
          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label"><span>提供方 provider</span><span class="behavior-desc">选择服务商；通用兼容用于其他 OpenAI 兼容端点</span></div>
            <select class="behavior-input" style="width:280px" v-model="embeddingDraft.provider">
              <option value="bailian">百炼（Bailian）</option>
              <option value="openai">OpenAI</option>
              <option value="ollama">Ollama</option>
              <option value="">通用 OpenAI 兼容</option>
            </select>
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

      <!-- ── 记忆维护：一键复核清理，见 scripts/refresh_memory.py ── -->
      <section v-if="activeTab === 'behavior'" class="config-card">
        <div class="card-head">
          <div class="card-icon" style="--ic:rgba(123,127,178,0.15);--stroke:#7b7fb2">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 10a6 6 0 1 1 2 4.5M4 10V6M4 10H8"/>
            </svg>
          </div>
          <div class="card-title-block">
            <h3>记忆维护</h3>
            <p>批量复核所有用户的记忆，一次做五件事：① 删掉 pattern.json 里不符合当前标准的旧条目 ② 把其中该算「用户画像」的条目搬进 profile.json ③ 把误进 profile 的阶段性事件迁去 memory.md ④ 把旧 daily.md 单行格式改成按日期分组的新格式 ⑤ 清掉已迁移完的遗留 facts.json/facts.md。<b>先预览、确认没问题再真执行</b>——①②涉及 LLM 判断、同一批数据可能不稳定，预览看到的就是真执行的，不会重新判断一遍；③④⑤是确定性改写，不受此影响。</p>
          </div>
        </div>

        <div class="behavior-grid">
          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label"><span>生成预览</span><span class="behavior-desc">对所有用户跑一次复核（每人独立判断 3 次取多数票），只读不写，后台跑</span></div>
            <div style="display:flex;gap:10px;align-items:center;justify-content:flex-end;min-width:0;">
              <span v-if="memCleanup.msg" :title="memCleanup.msg"
                    :style="{ color: memCleanup.error ? '#e07070' : '#4caf7d', fontSize:'12px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', minWidth:0 }">
                {{ memCleanup.msg }}
              </span>
              <button class="btn-ghost" style="flex-shrink:0;" :disabled="memCleanup.running" @click="startMemCleanupPreview">
                {{ memCleanup.running ? `预览中… ${memCleanup.done}/${memCleanup.total}` : '生成预览' }}
              </button>
            </div>
          </div>

          <div v-if="memCleanup.status === 'done'" class="behavior-item" style="grid-column: 1 / -1; flex-direction:column; align-items:stretch; gap:10px;">
            <div style="display:flex; align-items:center; justify-content:space-between;">
              <span class="behavior-desc">
                {{ memCleanupUserCount === 0 ? '预览完成：没有需要处理的内容' : `预览完成：${memCleanupUserCount} 个用户，共删 ${memCleanupTotalRemoved} 条 / 搬 ${memCleanupTotalMoved} 条去画像 / 迁 ${memCleanupTotalProfileEvents} 条画像事件到 memory / 迁 ${memCleanupTotalDaily} 条 daily / 清 ${memCleanupTotalLegacy} 个遗留文件` }}
              </span>
              <button v-if="memCleanupUserCount > 0" class="btn-ghost" style="font-size:12px;padding:4px 10px;" @click="memCleanup.expanded = !memCleanup.expanded">
                {{ memCleanup.expanded ? '收起明细' : '查看明细' }}
              </button>
            </div>
            <div v-if="memCleanup.expanded && memCleanupUserCount > 0" class="mem-cleanup-detail">
              <div v-for="(p, uid) in memCleanup.plan" :key="uid">
                <template v-if="p.removed_texts?.length || p.moved_texts?.length || p.profile_event_texts?.length || p.daily_texts?.length || p.legacy_files?.length">
                  <div class="mem-cleanup-uid">{{ uid }}（{{ p.total }} 条）</div>
                  <div v-for="(t, i) in p.removed_texts" :key="'r'+i" class="mem-cleanup-text">· [删] {{ t }}</div>
                  <div v-for="(t, i) in p.moved_texts" :key="'m'+i" class="mem-cleanup-text" style="color:rgba(123,127,178,0.85);">· [搬去画像] {{ t }}</div>
                  <div v-for="(t, i) in p.profile_event_texts" :key="'pe'+i" class="mem-cleanup-text" style="color:rgba(255, 196, 122, 0.9);">· [画像事件迁 memory] {{ t }}</div>
                  <div v-for="(t, i) in p.daily_texts" :key="'d'+i" class="mem-cleanup-text" style="color:rgba(117, 183, 255, 0.85);">· [迁 daily] {{ t }}</div>
                  <div v-for="(f, i) in p.legacy_files" :key="'l'+i" class="mem-cleanup-text" style="color:rgba(255,255,255,0.4);">· [清遗留文件] {{ f }}</div>
                </template>
                <template v-else-if="p.error">
                  <div class="mem-cleanup-uid" style="color:#e07070;">{{ uid }}：{{ p.error }}</div>
                </template>
              </div>
            </div>
            <div style="display:flex; justify-content:flex-end; gap:10px;">
              <span v-if="memCleanupApplyMsg" :style="{ fontSize:'12px', color: memCleanup.applyError ? '#e07070' : '#4caf7d' }">{{ memCleanupApplyMsg }}</span>
              <button v-if="memCleanupUserCount > 0" class="btn-primary" :disabled="memCleanup.applying" @click="applyMemCleanup">
                {{ memCleanup.applying ? '执行中…' : '确认执行' }}
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- ── IM 群组/member 记忆维护 ── -->
      <section v-if="activeTab === 'behavior'" class="config-card">
        <div class="card-head">
          <div class="card-title-block">
            <h3>IM 群组与成员记忆</h3>
            <p>逐作用域调用维护模型生成只读预览；只展示汇总结果，不展示任何用户、群组或成员标识。确认后才会投递实际整理任务。</p>
          </div>
        </div>
        <div v-if="imScopes.error" class="save-hint error">{{ imScopes.error }}</div>
        <div v-if="imScopes.message" class="save-hint">{{ imScopes.message }}</div>
        <div class="behavior-grid">
          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label"><span>生成维护预览</span><span class="behavior-desc">会调用 IM 维护模型，只读分析，后台运行</span></div>
            <div style="display:flex;gap:10px;align-items:center;justify-content:flex-end;min-width:0;">
              <span v-if="imModelPreview.message" class="behavior-desc">{{ imModelPreview.message }}</span>
              <button class="btn-ghost" style="flex-shrink:0;" :disabled="imModelPreview.running" @click="startImModelPreview">
                {{ imModelPreview.running ? `预览中… ${imModelPreview.done}/${imModelPreview.total}` : '生成预览' }}
              </button>
            </div>
          </div>
        </div>
        <div v-if="imModelPreview.hasRun && !imModelPreview.running">
          <div class="im-memory-summary-grid">
            <div><strong>{{ imScopes.summary.total_scopes }}</strong><span>作用域</span></div>
            <div><strong>{{ imScopes.summary.groups }}</strong><span>群组</span></div>
            <div><strong>{{ imScopes.summary.members }}</strong><span>成员</span></div>
            <div><strong>{{ imScopes.summary.total_entries }}</strong><span>记忆条目</span></div>
            <div><strong>{{ imModelPreview.needsReview }}</strong><span>模型建议整理</span></div>
            <div><strong>{{ imScopes.summary.needs_maintenance }}</strong><span>需整理作用域</span></div>
            <div><strong>{{ imScopes.summary.failed_jobs }}</strong><span>失败任务</span></div>
          </div>
          <div v-if="imScopes.summary.platforms.length" class="im-memory-platforms">
            <span v-for="platform in imScopes.summary.platforms" :key="platform.platform" class="im-memory-platform">
              {{ platform.platform }}：{{ platform.scopes }} 个作用域 / {{ platform.entries }} 条记忆
            </span>
          </div>
          <div class="im-memory-maintenance-actions">
            <span class="behavior-desc">只会整理尚未反思的新消息，不会删除已有记忆。</span>
            <button class="btn-primary" :disabled="imScopes.applying || !imModelPreview.planReady" @click="applyImMemoryMaintenance">
              {{ imScopes.applying ? '执行中…' : '确认整理全部待处理内容' }}
            </button>
          </div>
          <div v-if="imModelPreview.message" class="im-memory-progress">{{ imModelPreview.message }}</div>
        </div>
      </section>

      <!-- ── 状态命名 ── -->
      <section v-if="activeTab === 'labels'" class="config-card labels-card">
        <div class="card-head">
          <h3>状态命名</h3>
          <p>自定义对话里「状态指示」的显示名。留空＝用默认值。改完保存即时生效（工具名立即生效，「思考中」需刷新对话页）。</p>
        </div>

        <div class="labels-tip">
          <span class="labels-tip-icon">💡</span>
          <span>一个状态可填<b>多个名称</b>，用竖线 <code>|</code> 分隔，每次显示<b>随机取一个</b>。例：<code>咕咕在想…|让我捋捋一下|动动小脑瓜</code></span>
        </div>

        <div v-if="labelsLoading" class="placeholder-panel">加载中…</div>
        <template v-else>
          <!-- 特殊状态 -->
          <div class="labels-group-title">特殊状态</div>
          <div class="labels-list">
            <div v-for="row in stateLabels.special" :key="row.key" class="label-row">
              <div class="label-meta">
                <span class="label-key">{{ row.key }}</span>
                <span class="label-default">默认：{{ row.default || '（空·回退三个点）' }}</span>
              </div>
              <div class="label-input-wrap">
                <input v-model="row.custom" :placeholder="row.default || '留空＝三个点；多个用 | 分隔'" class="label-input" />
                <button v-if="row.custom" class="label-reset" title="恢复默认" @click="resetStateLabel(row)">×</button>
              </div>
            </div>
          </div>

          <!-- 工具 -->
          <div class="labels-group-title">
            工具（{{ filteredTools.length }}/{{ stateLabels.tools.length }}）
            <input v-model="labelsFilter" placeholder="筛选工具名 / 文案…" class="labels-filter" />
          </div>
          <div class="labels-list">
            <div v-for="row in filteredTools" :key="row.key" class="label-row">
              <div class="label-meta">
                <span class="label-key">{{ row.key }}</span>
                <span class="label-default">默认：{{ row.default }}</span>
              </div>
              <div class="label-input-wrap">
                <input v-model="row.custom" :placeholder="row.default" class="label-input" />
                <button v-if="row.custom" class="label-reset" title="恢复默认" @click="resetStateLabel(row)">×</button>
              </div>
            </div>
          </div>

          <div class="labels-save-bar">
            <span v-if="labelsSaved" class="labels-saved-tip">已保存 ✓</span>
            <button class="btn-primary" :disabled="labelsSaving" @click="saveStateLabels">
              {{ labelsSaving ? '保存中…' : '保存' }}
            </button>
          </div>
        </template>
      </section>

      <!-- ── 用量统计 ── -->
      <div v-if="activeTab === 'usage'">
        <div v-if="usageLoading && !usage" class="usage-loading">加载中…</div>
        <template v-else-if="usage">

          <!-- 汇总卡片 -->
          <div class="usage-summary">
            <div class="usage-stat-card">
              <div class="usc-label">今日对话</div>
              <div class="usc-num">{{ usage.today.calls }}</div>
              <div class="usc-sub">总计 {{ usage.total.calls }}</div>
            </div>
            <div class="usage-stat-card">
              <div class="usc-label">今日输入 tokens</div>
              <div class="usc-num">{{ fmtNum(usage.today.tokens_in) }}</div>
              <div class="usc-sub">总计 {{ fmtNum(usage.total.tokens_in) }}</div>
            </div>
            <div class="usage-stat-card">
              <div class="usc-label">今日输出 tokens</div>
              <div class="usc-num">{{ fmtNum(usage.today.tokens_out) }}</div>
              <div class="usc-sub">总计 {{ fmtNum(usage.total.tokens_out) }}</div>
            </div>
          </div>

          <!-- 折线图 -->
          <div class="config-card chart-card">
            <div class="chart-header">
              <!-- 指标切换 -->
              <div class="metric-tabs">
                <button v-for="m in metrics" :key="m.key"
                  class="metric-tab" :class="{ active: activeMetric === m.key }"
                  :data-label="m.label"
                  @click="activeMetric = m.key">{{ m.label }}</button>
                <span v-if="activeModel" class="model-filter-tag">
                  {{ activeModel }}
                </span>
              </div>
              <!-- 月份切换 -->
              <div class="month-nav">
                <button class="month-arrow" :disabled="monthIndex >= usage.months.length - 1"
                  @click="switchMonth(1)">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 12L6 8l4-4"/></svg>
                </button>
                <span class="month-label">{{ usage.month }}</span>
                <button class="month-arrow" :disabled="monthIndex <= 0"
                  @click="switchMonth(-1)">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 12l4-4-4-4"/></svg>
                </button>
              </div>
            </div>

            <!-- SVG 折线图 -->
            <div class="chart-wrap" ref="chartWrap" :style="usageLoading ? 'opacity:0.5;transition:opacity 0.15s' : 'opacity:1;transition:opacity 0.15s'">
              <svg class="line-chart" :width="CHART_W" :height="CHART_H">
                <defs>
                  <linearGradient :id="`grad-${activeMetric}`" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stop-color="rgba(149,144,196,0.18)"/>
                    <stop offset="75%"  stop-color="rgba(149,144,196,0.04)"/>
                    <stop offset="100%" stop-color="rgba(149,144,196,0)"/>
                  </linearGradient>
                  <filter id="glow">
                    <feGaussianBlur stdDeviation="2" result="blur"/>
                    <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
                  </filter>
                </defs>

                <!-- 网格线（只画横线，更干净） -->
                <line v-for="(y, i) in gridYs.slice(1)" :key="'gy'+i"
                  :x1="PAD_L" :y1="y" :x2="chartRight" :y2="y"
                  stroke="rgba(255,255,255,0.05)" stroke-width="1"/>

                <!-- 底部基线 -->
                <line :x1="PAD_L" :y1="CHART_H - PAD_B"
                  :x2="chartRight" :y2="CHART_H - PAD_B"
                  stroke="rgba(255,255,255,0.1)" stroke-width="1"/>

                <!-- 填充区域 -->
                <path v-if="chartPoints.length > 1"
                  :d="fillPath" :fill="`url(#grad-${activeMetric})`"/>

                <!-- 折线 -->
                <path v-if="chartPoints.length > 1"
                  :d="linePath"
                  fill="none" stroke="rgba(149,144,196,0.15)" stroke-width="4"
                  stroke-linecap="round" stroke-linejoin="round"/>
                <path v-if="chartPoints.length > 1"
                  :d="linePath"
                  fill="none" stroke="rgba(169,164,216,0.75)" stroke-width="1.2"
                  stroke-linecap="round" stroke-linejoin="round"/>

                <!-- hover 竖线 -->
                <line v-if="hoverIdx >= 0"
                  :x1="chartPoints[hoverIdx].x" :y1="PAD_T"
                  :x2="chartPoints[hoverIdx].x" :y2="CHART_H - PAD_B"
                  stroke="rgba(255,255,255,0.1)" stroke-width="1" stroke-dasharray="4 4"/>

                <!-- 数据点（只在 hover 时显示高亮点） -->
                <g v-if="hoverIdx >= 0 && chartPoints[hoverIdx]">
                  <circle
                    :cx="chartPoints[hoverIdx].x" :cy="chartPoints[hoverIdx].y" r="5"
                    fill="rgba(149,144,196,0.2)" stroke="none"/>
                  <circle
                    :cx="chartPoints[hoverIdx].x" :cy="chartPoints[hoverIdx].y" r="3"
                    fill="#a9a4d8" stroke="rgba(13,13,20,0.9)" stroke-width="1.5"/>
                </g>

                <!-- 不可见的 hover 感应区（每列宽条） -->
                <rect v-for="(pt, i) in chartPoints" :key="'hr'+i"
                  :x="pt.x - hoverColW / 2" :y="PAD_T"
                  :width="hoverColW" :height="CHART_H - PAD_T - PAD_B"
                  fill="transparent"
                  @mouseenter="hoverIdx = i" @mouseleave="hoverIdx = -1"
                  style="cursor:crosshair"/>

                <!-- X 轴标签 -->
                <text v-for="(pt, i) in xLabels" :key="'xl'+i"
                  :x="pt.x" :y="CHART_H - PAD_B + 13"
                  text-anchor="middle" font-size="9" fill="rgba(255,255,255,0.18)"
                  font-family="system-ui,sans-serif">{{ pt.label }}</text>

                <!-- Y 轴标签 -->
                <text v-for="(v, i) in gridValues.slice(0, -1)" :key="'yv'+i"
                  :x="PAD_L - 7" :y="gridYs[i] + 3"
                  text-anchor="end" font-size="9" fill="rgba(255,255,255,0.18)"
                  font-family="system-ui,sans-serif">{{ fmtNum(v) }}</text>
              </svg>

              <!-- Tooltip -->
              <Transition name="tt">
                <div v-if="hoverIdx >= 0 && chartPoints[hoverIdx]"
                  class="chart-tooltip"
                  :style="tooltipStyle">
                  <div class="tt-date">{{ usage.daily[hoverIdx]?.date }}</div>
                  <div class="tt-val">
                    {{ fmtNum(usage.daily[hoverIdx]?.[activeMetric] ?? 0) }}
                    <span>{{ metrics.find(m => m.key === activeMetric)?.unit }}</span>
                  </div>
                </div>
              </Transition>
            </div>
          </div>

          <!-- 按模型分组 -->
          <div class="config-card" v-if="usage.by_model.length">
            <div class="card-head">
              <div class="card-title-block">
                <h3>按模型</h3>
                <p>点击行在图表中单独查看</p>
              </div>
              <button v-if="activeModel" class="clear-model-btn" @click="toggleModel(activeModel)">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 2l8 8M10 2l-8 8"/></svg>
                清除筛选
              </button>
            </div>
            <div class="model-table">
              <div class="mt-row mt-head">
                <span>模型</span><span>对话数</span><span>输入</span><span>输出</span>
              </div>
              <div
                class="mt-row mt-clickable"
                :class="{ 'mt-active': activeModel === m.model, 'mt-dimmed': activeModel && activeModel !== m.model }"
                v-for="m in usage.by_model"
                :key="m.model"
                @click="toggleModel(m.model)"
              >
                <span class="mt-model">
                  {{ m.model }}<em>{{ m.provider }}</em>
                </span>
                <span>{{ m.calls }}</span>
                <span>{{ fmtNum(m.tokens_in) }}</span>
                <span>{{ fmtNum(m.tokens_out) }}</span>
              </div>
            </div>
          </div>

          <div v-if="!usage.by_model.length && !usage.daily.some((d: any) => d.calls > 0)" class="usage-empty">
            暂无数据，发起对话后将开始记录
          </div>

        </template>
      </div>

      <!-- ── 决策轨迹（只读调试）── -->
      <div v-if="activeTab === 'trace'" class="trace-wrap">
        <!-- 会话列表 -->
        <div class="trace-list">
          <div class="trace-search">
            <input v-model="traceUser" placeholder="按用户名筛选…" v-enter="fetchTraceSessions" />
            <button @click="fetchTraceSessions">搜索</button>
          </div>
          <div v-if="traceLoading" class="trace-hint">加载中…</div>
          <template v-else>
            <div v-for="s in traceSessions" :key="s.id"
              class="trace-sess" :class="{ active: traceSel === s.id }" @click="openTrace(s.id)">
              <div class="ts-top"><span class="ts-src" :class="'src-'+s.source">{{ s.source }}</span><span class="ts-title">{{ s.title }}</span></div>
              <div class="ts-meta">{{ s.user }} · {{ s.msgCount }} 条 · #{{ s.id }} · {{ fmtTraceTime(s.updatedAt) }}</div>
            </div>
            <div v-if="!traceSessions.length" class="trace-hint">无会话</div>
          </template>
        </div>
        <!-- 轨迹时间线 -->
        <div class="trace-detail">
          <div v-if="traceDetailLoading" class="trace-empty">加载中…</div>
          <div v-else-if="!traceData" class="trace-empty">← 左侧选一个会话，查看咕咕每轮的决策轨迹</div>
          <template v-else>
            <div class="trace-head">
              <div class="th-title">{{ traceData.session.title }}</div>
              <div class="th-meta">{{ traceData.session.user }} · {{ traceData.session.source }} · #{{ traceData.session.id }}
                · LLM 调用 {{ traceData.usage.length }} 次 · token 入 {{ traceTokens.in }} / 出 {{ traceTokens.out }}</div>
            </div>
            <div class="trace-timeline">
              <div v-for="(step, i) in traceSteps" :key="i" class="tstep" :class="'k-'+step.kind">
                <template v-if="step.kind === 'user'">
                  <div class="tstep-role user">用户</div>
                  <div class="tstep-text">{{ step.text }}</div>
                </template>
                <template v-else-if="step.kind === 'ai'">
                  <div class="tstep-role ai">咕咕</div>
                  <div class="tstep-text">{{ step.text }}</div>
                  <div v-if="step.files && step.files.length" class="tstep-files">📎 {{ step.files.map((f: any) => f.name + '.' + f.ext).join('，') }}</div>
                </template>
                <template v-else-if="step.kind === 'tool_call'">
                  <div class="tstep-tool">
                    <span class="tool-badge call">🔧 {{ step.name }}</span>
                    <button class="tool-toggle" @click="step._open = !step._open">{{ step._open ? '收起入参' : '入参' }}</button>
                  </div>
                  <pre v-if="step._open" class="tool-json">{{ step.input }}</pre>
                </template>
                <template v-else-if="step.kind === 'tool_result'">
                  <div class="tstep-tool">
                    <span class="tool-badge res" :class="{ err: step.isError }">↩ {{ step.isError ? '结果（错误）' : '结果' }}</span>
                    <button class="tool-toggle" @click="step._open = !step._open">{{ step._open ? '收起' : '展开' }}</button>
                  </div>
                  <pre v-if="step._open" class="tool-json">{{ step.result }}</pre>
                </template>
              </div>
            </div>
          </template>
        </div>
      </div>

    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue'
import { PhBrain, PhEye, PhVideo, PhMicrophone } from '@phosphor-icons/vue'
import AdminSelect from '@/components/AdminSelect.vue'
import { useConfigStore } from '@/stores/config'
import { useAdminStore } from '@/stores/admin'
import { showAppError } from '@/composables/useAppToast'
import ConfigField from '../Config/components/ConfigField.vue'

const configStore = useConfigStore()
const adminStore  = useAdminStore()

const tabs = [
  { key: 'llm',      label: 'LLM 配置' },
  { key: 'capabilities', label: '能力目录' },
  { key: 'behavior', label: '行为配置' },
  { key: 'labels',   label: '状态命名' },
  { key: 'usage',    label: '用量统计' },
  { key: 'trace',    label: '决策轨迹' },
  { key: 'prompts',  label: '系统提示词' },
]
const activeTab = ref('llm')

function switchTab(key: string) {
  activeTab.value = key
  if (key === 'llm'     && presets.value.length === 0) fetchPresets()
  if (key === 'capabilities' && !capabilityCatalog.value) fetchCapabilityCatalog()
  if (key === 'prompts' && profiles.value.length === 0) fetchProfiles()
  if (key === 'usage'   && !usage.value) fetchUsage()
  if (key === 'trace'   && traceSessions.value.length === 0) fetchTraceSessions()
  if (key === 'labels'  && !stateLabels.special.length && !stateLabels.tools.length) fetchStateLabels()
  if (key === 'behavior' && imScopes.summary.total_scopes === 0) loadImScopes()
}

type CapabilityCatalogItem = {
  name: string
  description_short: string
  category: string
  permissions: string[]
  platforms: string[]
  related_skills: string[]
  related_tools: string[]
  source: string
  enabled: boolean
}
const capabilityCatalog = ref<{
  generation: number
  diagnostics: string[]
  tools: CapabilityCatalogItem[]
  skills: CapabilityCatalogItem[]
} | null>(null)
const capabilityCatalogLoading = ref(false)
const capabilityCatalogError = ref('')

async function fetchCapabilityCatalog() {
  capabilityCatalogLoading.value = true
  capabilityCatalogError.value = ''
  try {
    const res = await adminStore.authFetch('/api/v1/admin/agent/capabilities')
    if (!res.ok) throw new Error(`加载能力目录失败（${res.status}）`)
    capabilityCatalog.value = await res.json()
  } catch (error) {
    capabilityCatalogError.value = error instanceof Error ? error.message : '加载能力目录失败'
  } finally {
    capabilityCatalogLoading.value = false
  }
}

// ── 状态命名（对话里状态指示的显示名）──────────────────────────────────────────
const stateLabels  = reactive<{ special: any[]; tools: any[] }>({ special: [], tools: [] })
const labelsLoading = ref(false)
const labelsSaving  = ref(false)
const labelsFilter  = ref('')
const labelsSaved   = ref(false)

const filteredTools = computed(() => {
  const q = labelsFilter.value.trim().toLowerCase()
  if (!q) return stateLabels.tools
  return stateLabels.tools.filter(r =>
    r.key.toLowerCase().includes(q) || (r.default || '').includes(q) || (r.custom || '').includes(q))
})

async function fetchStateLabels() {
  labelsLoading.value = true
  try {
    const res = await adminStore.authFetch('/api/v1/admin/agent/state-labels')
    const data = await res.json()
    stateLabels.special = (data.special || []).map((r: any) => ({ ...r }))
    stateLabels.tools   = (data.tools   || []).map((r: any) => ({ ...r }))
  } catch (e) {
    console.error('加载状态命名失败', e)
  } finally {
    labelsLoading.value = false
  }
}

async function saveStateLabels() {
  labelsSaving.value = true
  labelsSaved.value = false
  try {
    const overrides: Record<string, any> = {}
    for (const r of [...stateLabels.special, ...stateLabels.tools]) {
      const v = (r.custom || '').trim()
      if (v && v !== r.default) overrides[r.key] = v   // 只提交「改过且非空」的，空/同默认走回退
    }
    const res = await adminStore.authFetch('/api/v1/admin/agent/state-labels', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides }),
    })
    if (!res.ok) throw new Error('保存失败')
    labelsSaved.value = true
    setTimeout(() => { labelsSaved.value = false }, 2000)
  } catch (e) {
    console.error('保存状态命名失败', e)
    showAppError('保存失败，请重试')
  } finally {
    labelsSaving.value = false
  }
}

function resetStateLabel(row: any) { row.custom = '' }

// ── 决策轨迹（只读调试）──────────────────────────────────────────────────────
const traceSessions      = ref<any[]>([])
const traceLoading       = ref(false)
const traceSel           = ref<any | null>(null)
const traceData          = ref<any | null>(null)
const traceSteps         = ref<any[]>([])
const traceDetailLoading = ref(false)
const traceSearch        = ref('')
const traceUser          = ref('')

function fmtTraceTime(iso: string) {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const traceTokens = computed(() => {
  const u = traceData.value?.usage ?? []
  return {
    in:  u.reduce((a: number, x: any) => a + (x.tokensIn  || 0), 0),
    out: u.reduce((a: number, x: any) => a + (x.tokensOut || 0), 0),
  }
})

async function fetchTraceSessions() {
  traceLoading.value = true
  try {
    const qs = new URLSearchParams()
    if (traceSearch.value.trim()) qs.set('q', traceSearch.value.trim())
    if (traceUser.value.trim())   qs.set('user', traceUser.value.trim())
    const url = `/api/v1/admin/agent/sessions${qs.toString() ? '?' + qs : ''}`
    const res = await adminStore.authFetch(url)
    if (res.ok) traceSessions.value = await res.json()
  } catch { /* ignore */ }
  finally { traceLoading.value = false }
}

// content_json 块 → 可读结果文本（content 可能是字符串或块数组）
function _extractResult(content: any) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(c => typeof c === 'string' ? c : (c?.text ?? JSON.stringify(c))).join('\n')
  return JSON.stringify(content, null, 2)
}

// 把消息序列拍平成时间线步骤（含被 getMessages 过滤的 tool_use/tool_result）
function _buildSteps(messages: any[]) {
  const steps = []
  for (const m of messages) {
    const cj = m.contentJson
    if (!cj) {
      const text = (m.content || '').trim()
      if (text) steps.push({ kind: (m.role === 'assistant' || m.role === 'ai') ? 'ai' : 'user', text, files: m.files, _open: false })
      continue
    }
    for (const b of cj) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'text' && (b.text || '').trim()) {
        steps.push({ kind: 'ai', text: b.text, _open: false })
      } else if (b.type === 'tool_use') {
        steps.push({ kind: 'tool_call', name: b.name, input: JSON.stringify(b.input ?? {}, null, 2), _open: false })
      } else if (b.type === 'tool_result') {
        steps.push({ kind: 'tool_result', result: _extractResult(b.content), isError: !!b.is_error, _open: false })
      }
    }
  }
  return steps
}

async function openTrace(id: any) {
  traceSel.value = id
  traceDetailLoading.value = true
  traceData.value = null
  traceSteps.value = []
  try {
    const res = await adminStore.authFetch(`/api/v1/admin/agent/sessions/${id}/trace`)
    if (res.ok) {
      const data = await res.json()
      traceData.value = data
      traceSteps.value = _buildSteps(data.messages)
    }
  } catch { /* ignore */ }
  finally { traceDetailLoading.value = false }
}


// ── LLM 预设 ──────────────────────────────────────────────────────────────
const PROVIDERS = [
  { key: 'openai',    label: 'OpenAI 兼容', base_url: 'https://api.openai.com/v1',                          model: 'gpt-4o' },
  { key: 'anthropic', label: 'Anthropic',   base_url: 'https://api.anthropic.com/v1',                       model: 'claude-opus-4-8' },
  { key: 'qwen',      label: 'DashScope(百炼)', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-max' },
  { key: 'deepseek',  label: 'DeepSeek',    base_url: 'https://api.deepseek.com',                           model: 'deepseek-v4-flash-vision-exp' },
  { key: 'minimax',   label: 'MiniMax',     base_url: 'https://api.minimaxi.com/anthropic',                 model: 'MiniMax-M3' },
  { key: 'mimo',      label: 'MiMo (小米)',  base_url: 'https://api.xiaomimimo.com/v1',                       model: 'mimo-v2.5' },
  { key: 'ollama',    label: 'Ollama',      base_url: 'http://127.0.0.1:11434/v1',                          model: 'qwen3:8b' },
  { key: 'local',     label: '本地兼容服务', base_url: '',                                                   model: '' },
]

const LOCAL_RUNTIMES = [
  { key: 'llama.cpp', label: 'llama.cpp' },
  { key: 'vllm', label: 'vLLM' },
  { key: 'other', label: '其它兼容服务' },
]
const LOCAL_CAPABILITIES = [
  { key: 'tools', label: '工具调用' },
  { key: 'structured_json', label: 'JSON 输出' },
  { key: 'structured_schema', label: 'JSON Schema' },
  { key: 'thinking', label: '思考/推理' },
]

// MiMo 同时提供 OpenAI / Anthropic 两套兼容 API，按预设选格式（影响后端走哪条通道）
const API_FORMATS = [
  { key: 'openai',    label: 'OpenAI 格式' },
  { key: 'anthropic', label: 'Anthropic 格式' },
]

const presets        = ref<any[]>([])
const activePresetId = ref('')
const strategy       = ref('active')   // active 单一激活 | pool 多 key 分流 | router 智能路由
const poolMode       = ref('random')   // pool 分流方式：random | round_robin | least_loaded
const presetsLoading = ref(false)
const llmMsg         = ref('')
const llmMsgError    = ref(false)
const testingId      = ref<any | null>(null)
const activatingId   = ref<any | null>(null)
const probingId      = ref<any | null>(null)
const probingDim     = ref<string | null>(null)   // 弹窗内正在检测的维度（image/video/audio）
const capabilityProbeLoading = ref(false)

// 多模态三维度：图片→vision，视频→vision_video，音频→vision_audio
const visionDims = [
  { key: 'image', label: '图片', hint: '用户发的图片直接给模型「看」' },
  { key: 'video', label: '视频', hint: '用户发的视频直接给模型「看」' },
  { key: 'audio', label: '音频', hint: '用户发的音频直接给模型「听」' },
]
const DEEPSEEK_EFFORTS = [
  { key: '', label: '默认' },
  { key: 'low', label: 'low' },
  { key: 'high', label: 'high' },
  { key: 'max', label: 'max' },
]
const IMAGE_DETAIL_LEVELS = [
  { key: 'auto', label: 'auto' },
  { key: 'low', label: 'low' },
  { key: 'high', label: 'high' },
  { key: 'original', label: 'original' },
]

// edit modal
const editTarget   = ref<any | null>(null)
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

function showMsg(msg: string, isError = false) {
  llmMsg.value      = msg
  llmMsgError.value = isError
  setTimeout(() => { llmMsg.value = '' }, isError ? 5000 : 3000)
}

async function fetchPresets() {
  presetsLoading.value = true
  try {
    const res  = await adminStore.authFetch('/api/v1/admin/agent/llm-presets')
    const data = await res.json()
    presets.value        = data.items || []
    activePresetId.value = data.active_id || ''
    strategy.value       = data.strategy || 'active'
    poolMode.value       = data.pool_mode || 'random'
  } catch (e) {
    showMsg('加载失败：' + (e instanceof Error ? e.message : String(e)), true)
  } finally {
    presetsLoading.value = false
  }
}

async function setStrategy(s: any) {
  const prev = strategy.value
  strategy.value = s
  try {
    const res = await adminStore.authFetch('/api/v1/admin/agent/llm-presets/strategy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy: s }),
    })
    if (!res.ok) throw new Error((await res.json()).detail || '设置失败')
    showMsg(s === 'pool' ? '已切到多 key 分流（勾选要参与分流的预设）' : s === 'router' ? '已切到智能路由（待 Router 接入，暂等同单一激活）' : '已切到单一激活')
  } catch (e) {
    strategy.value = prev
    showMsg('切换策略失败：' + (e instanceof Error ? e.message : String(e)), true)
  }
}

async function setPoolMode(m: any) {
  const prev = poolMode.value
  poolMode.value = m
  try {
    const res = await adminStore.authFetch('/api/v1/admin/agent/llm-presets/strategy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pool_mode: m }),
    })
    if (!res.ok) throw new Error('设置失败')
    showMsg(({ random: '分流方式：随机', round_robin: '分流方式：轮询', least_loaded: '分流方式：最少在途（自动避开慢 key）' } as Record<string,string>)[m])
  } catch (e) {
    poolMode.value = prev
    showMsg('设置分流方式失败：' + (e instanceof Error ? e.message : String(e)), true)
  }
}

async function saveConcurrency() {
  const n = agentDraft.worker_concurrency
  if (!Number.isFinite(n) || n < 1) { agentDraft.worker_concurrency = 16; return }
  try {
    await configStore.saveConfig({ agent: { ...agentDraft } })
    showMsg(`并发量已设为 ${n}（worker ≤30s 热生效）`)
  } catch (e) {
    showMsg('保存并发量失败：' + (e instanceof Error ? e.message : String(e)), true)
  }
}

async function togglePool(p: any) {
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
}

function openEditPreset(p: any) {
  editIsNew.value  = false
  editTarget.value = { ...p, api_key: '', vision_detail: p.vision_detail || 'auto', ollama_mode: p.ollama_mode || 'local', ollama_api_mode: p.ollama_api_mode || 'native', ollama_keep_alive: p.ollama_keep_alive || '5m', deployment_mode: p.deployment_mode || (p.provider === 'local' ? 'local' : 'cloud'), local_runtime: p.local_runtime || 'other', capability_overrides: p.capability_overrides || {} }
  editError.value  = ''
  modelOptions.value = []
  modelListError.value = ''
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
  if (!id || capabilityProbeLoading.value) return
  capabilityProbeLoading.value = true
  try {
    const res = await adminStore.authFetch(`/api/v1/admin/agent/llm-presets/${id}/capabilities`, { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.detail || '能力检测失败')
    editTarget.value.capability_checked_at = data.checked_at || ''
    editTarget.value.capability_fingerprint = data.fingerprint || ''
    showMsg('本地能力检测完成')
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
  if (!editTarget.value || modelListLoading.value) return
  modelListLoading.value = true
  modelListError.value = ''
  modelMenuOpen.value = true
  try {
    let res
    if (editIsNew.value) {
      // 新建时用表单里的临时配置获取，无需先保存
      res = await adminStore.authFetch('/api/v1/admin/agent/llm-presets/models-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: editTarget.value.provider,
          base_url: editTarget.value.base_url,
          api_key: editTarget.value.api_key,
          api_format: editTarget.value.api_format || '',
          local_runtime: editTarget.value.local_runtime || 'other',
        }),
      })
    } else {
      res = await adminStore.authFetch(`/api/v1/admin/agent/llm-presets/${editTarget.value.id}/models`)
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
  const pv = PROVIDERS.find(p => p.key === key)
  if (!pv) return
  editTarget.value.provider = key
  editTarget.value.base_url = pv.base_url
  editTarget.value.model    = pv.model
  // mimo 同时提供两套 API：默认 openai 格式；切到别的 provider 清掉（走自动判定）
  editTarget.value.api_format = key === 'mimo' ? 'openai' : ''
  editTarget.value.deployment_mode = key === 'local' ? 'local' : 'cloud'
  editTarget.value.ollama_mode = key === 'ollama' ? 'local' : (editTarget.value.ollama_mode || 'local')
  if (key === 'ollama') {
    editTarget.value.ollama_api_mode = editTarget.value.ollama_api_mode || 'native'
    editTarget.value.ollama_keep_alive = editTarget.value.ollama_keep_alive || '5m'
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
  editTarget.value.api_format = fmt
  const bu = (editTarget.value.base_url || '').replace(/\/(v1|anthropic)\/?$/, '')
  if (bu.includes('xiaomimimo')) {
    editTarget.value.base_url = bu + (fmt === 'anthropic' ? '/anthropic' : '/v1')
  }
  modelOptions.value = []
  modelListError.value = ''
}

async function savePreset() {
  editSaving.value = true
  editError.value  = ''
  try {
    const body = { ...editTarget.value }
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

async function activatePreset(id: any) {
  activatingId.value = id
  try {
    const res = await adminStore.authFetch(`/api/v1/admin/agent/llm-presets/${id}/activate`, { method: 'POST' })
    if (!res.ok) throw new Error(`切换失败（${res.status}）`)
    activePresetId.value = id
    showMsg('已切换，即时生效')
  } catch (e) {
    showMsg((e instanceof Error ? e.message : String(e)), true)
  } finally {
    activatingId.value = null
  }
}

async function deletePreset(id: any) {
  if (!confirm('确定删除该预设？')) return
  try {
    const res = await adminStore.authFetch(`/api/v1/admin/agent/llm-presets/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.detail || `删除失败（${res.status}）`)
    }
    await fetchPresets()
  } catch (e) {
    showMsg((e instanceof Error ? e.message : String(e)), true)
  }
}

async function testPreset(id: any) {
  testingId.value = id
  try {
    const res  = await adminStore.authFetch(`/api/v1/admin/agent/llm-presets/${id}/test`, { method: 'POST' })
    const data = await res.json()
    showMsg(data.ok ? `连通正常（${data.status}）` : `连接失败（${data.status}）：${data.detail}`, !data.ok)
  } catch (e) {
    showMsg('测试失败：' + (e instanceof Error ? e.message : String(e)), true)
  } finally {
    testingId.value = null
  }
}

// 多模态探测：发极小媒体给该预设模型，按响应判定是否支持对应维度，结论自动写回。
// 卡片按钮不传 dim → 依次测图片/视频/音频三维度；弹窗内按钮传 dim → 只测单维度。
async function probeVision(id: any, dim?: string) {
  if (dim) {
    probingDim.value = dim
  } else {
    probingId.value = id
  }
  try {
    const url = `/api/v1/admin/agent/llm-presets/${id}/probe-vision` + (dim ? `?dim=${dim}` : '')
    const res  = await adminStore.authFetch(url, { method: 'POST' })
    const data = await res.json()
    if (dim) {
      // 单维度（弹窗内）
      const label = visionDims.find(d => d.key === dim)?.label || dim
      if (data.supported === true)       showMsg(`✅ ${label}：支持，已开启`)
      else if (data.supported === false) showMsg(`${label}：不支持，已设为关闭：${data.detail}`, true)
      else                               showMsg(`${label}：测不准：${data.detail}`, true)
      if (data.supported === true) {
        const field = dim === 'image' ? 'vision' : 'vision_' + dim
        editTarget.value[field] = true
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

// ── 系统提示词 ────────────────────────────────────────────────────────────
const activeProfile  = ref('default')
const profiles       = ref<any[]>([])
const placeholders   = ref<any[]>([])
const promptContent  = ref('')
const promptSaving   = ref(false)
const promptSaved    = ref(false)
const promptError    = ref('')
const promptCache: Record<string, any>    = {}

async function fetchProfiles() {
  try {
    const res  = await adminStore.authFetch('/api/v1/admin/agent/prompts')
    const data = await res.json()
    profiles.value     = data.profiles
    placeholders.value = data.placeholders
    await loadPrompt('default')
  } catch (e) {
    promptError.value = '加载失败：' + (e instanceof Error ? e.message : String(e))
  }
}

async function loadPrompt(profile: any) {
  if (promptCache[profile] !== undefined) {
    promptContent.value = promptCache[profile]
    return
  }
  try {
    const res  = await adminStore.authFetch(`/api/v1/admin/agent/prompts/${profile}`)
    const data = await res.json()
    promptCache[profile] = data.content
    promptContent.value  = data.content
  } catch (e) {
    promptError.value = '加载失败：' + (e instanceof Error ? e.message : String(e))
  }
}

async function switchProfile(profile: any) {
  promptCache[activeProfile.value] = promptContent.value
  activeProfile.value = profile
  await loadPrompt(profile)
}

function insertPlaceholder(key: string) {
  const ta = document.querySelector<HTMLTextAreaElement>('.prompt-textarea')
  if (!ta) return
  const start = ta.selectionStart ?? 0
  const end   = ta.selectionEnd ?? 0
  const text  = promptContent.value
  promptContent.value = text.slice(0, start) + key + text.slice(end)
}

async function savePrompt() {
  promptSaving.value = true
  promptSaved.value  = false
  promptError.value  = ''
  try {
    const res = await adminStore.authFetch(`/api/v1/admin/agent/prompts/${activeProfile.value}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: promptContent.value }),
    })
    if (!res.ok) throw new Error(`保存失败（${res.status}）`)
    promptCache[activeProfile.value] = promptContent.value
    promptSaved.value = true
    setTimeout(() => { promptSaved.value = false }, 3000)
  } catch (e) {
    promptError.value = (e instanceof Error ? e.message : String(e))
    setTimeout(() => { promptError.value = '' }, 5000)
  } finally {
    promptSaving.value = false
  }
}

// ── 行为配置 ──────────────────────────────────────────────────────────────
const agentDraft    = reactive({ ...configStore.cfg.agent })
const behaviorSaving = ref(false)
const behaviorSaved  = ref(false)
const behaviorError  = ref('')

function resetBehavior() {
  Object.assign(agentDraft, configStore.cfg.agent)
}

async function saveBehavior() {
  behaviorSaving.value = true
  behaviorSaved.value  = false
  behaviorError.value  = ''
  try {
    await configStore.saveConfig({ agent: { ...agentDraft } })
    behaviorSaved.value = true
    setTimeout(() => { behaviorSaved.value = false }, 3000)
  } catch (e) {
    behaviorError.value = (e instanceof Error ? e.message : String(e))
    setTimeout(() => { behaviorError.value = '' }, 5000)
  } finally {
    behaviorSaving.value = false
  }
}

// ── 搜索配置：联网搜索与相似图搜索分开维护，避免一个区域的保存覆盖另一区域 ──
const generalSearchDraft = reactive({
  tavily_api_key: configStore.cfg.search.tavily_api_key,
  searxng_url: configStore.cfg.search.searxng_url,
  searxng_engines: configStore.cfg.search.searxng_engines,
  searxng_image_engines: configStore.cfg.search.searxng_image_engines,
  max_results: configStore.cfg.search.max_results,
})
const similarImageDraft = reactive({
  similar_image_enabled: configStore.cfg.search.similar_image_enabled,
  baidu_qianfan_api_key: configStore.cfg.search.baidu_qianfan_api_key,
  similar_image_default_count: configStore.cfg.search.similar_image_default_count,
  similar_image_timeout_seconds: configStore.cfg.search.similar_image_timeout_seconds,
  similar_image_limit_daily: configStore.cfg.search.similar_image_limit_daily,
})
const generalSearchSaving = ref(false)
const generalSearchSaved = ref(false)
const generalSearchError = ref('')
const similarImageSaving = ref(false)
const similarImageSaved = ref(false)
const similarImageError = ref('')

function resetGeneralSearch() {
  Object.assign(generalSearchDraft, {
    tavily_api_key: configStore.cfg.search.tavily_api_key,
    searxng_url: configStore.cfg.search.searxng_url,
    searxng_engines: configStore.cfg.search.searxng_engines,
    searxng_image_engines: configStore.cfg.search.searxng_image_engines,
    max_results: configStore.cfg.search.max_results,
  })
}

function resetSimilarImageSearch() {
  Object.assign(similarImageDraft, {
    similar_image_enabled: configStore.cfg.search.similar_image_enabled,
    baidu_qianfan_api_key: configStore.cfg.search.baidu_qianfan_api_key,
    similar_image_default_count: configStore.cfg.search.similar_image_default_count,
    similar_image_timeout_seconds: configStore.cfg.search.similar_image_timeout_seconds,
    similar_image_limit_daily: configStore.cfg.search.similar_image_limit_daily,
  })
}

// ── 语音识别模型 ──
const voiceDraft  = reactive({ ...configStore.cfg.voice })
const voiceSaving = ref(false)
const voiceSaved  = ref(false)
const voiceError  = ref('')
const voiceTesting = ref(false)
const voiceTestMsg = ref('')
function resetVoice() { Object.assign(voiceDraft, configStore.cfg.voice) }
const VOICE_API_FORMATS = [
  { value: 'openai', label: 'OpenAI 兼容' },
  { value: 'dashscope', label: '百炼 DashScope' },
]
const VOICE_DASHSCOPE_SERVICES = [
  { value: 'qwen3-asr', label: 'Qwen3 ASR · qwen3-asr-flash' },
  { value: 'qwen-audio', label: 'Qwen-Audio 3.0 · qwen-audio-3.0-asr-flash' },
  { value: 'fun-asr', label: 'Fun-ASR · fun-asr-flash-2026-06-15' },
]
function setDashscopeService(value: string) {
  voiceDraft.dashscope_service = value
  const examples: Record<string, string> = {
    'qwen3-asr': 'qwen3-asr-flash',
    'qwen-audio': 'qwen-audio-3.0-asr-flash',
    'fun-asr': 'fun-asr-flash-2026-06-15',
  }
  voiceDraft.model = examples[value] || ''
}
async function saveVoice() {
  voiceSaving.value = true; voiceSaved.value = false; voiceError.value = ''
  try {
    await configStore.saveConfig({ voice: { ...voiceDraft } })
    voiceSaved.value = true
    Object.assign(voiceDraft, configStore.cfg.voice)   // key 存后回 ****，同步回「不修改」态
    setTimeout(() => { voiceSaved.value = false }, 3000)
  } catch (e) {
    voiceError.value = (e instanceof Error ? e.message : String(e)) || '保存失败'
  } finally {
    voiceSaving.value = false
  }
}

async function testVoice() {
  voiceTesting.value = true
  voiceError.value = ''
  voiceTestMsg.value = ''
  try {
    const res = await adminStore.authFetch('/api/v1/admin/config/test-voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_format: voiceDraft.api_format,
        dashscope_service: voiceDraft.dashscope_service,
        base_url: voiceDraft.base_url,
        api_key: voiceDraft.api_key,
        model: voiceDraft.model,
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok) throw new Error(data.message || `测试失败（${res.status}）`)
    voiceSaved.value = false
    voiceTestMsg.value = data.message || '语音模型连接正常'
    setTimeout(() => { voiceTestMsg.value = '' }, 5000)
  } catch (e) {
    voiceError.value = e instanceof Error ? e.message : String(e)
  } finally {
    voiceTesting.value = false
  }
}

// ── 向量 Embedding 模型 ──
const embeddingDraft  = reactive({ ...configStore.cfg.embedding })
const embeddingSaving = ref(false)
const embeddingSaved  = ref(false)
const embeddingError  = ref('')
const embTest = reactive({ loading: false, ok: false, msg: '' })
function resetEmbedding() { Object.assign(embeddingDraft, configStore.cfg.embedding) }
async function saveEmbedding() {
  embeddingSaving.value = true; embeddingSaved.value = false; embeddingError.value = ''
  try {
    await configStore.saveConfig({ embedding: { ...embeddingDraft } })
    embeddingSaved.value = true
    Object.assign(embeddingDraft, configStore.cfg.embedding)   // key 存后回 ****，同步回「不修改」态
    setTimeout(() => { embeddingSaved.value = false }, 3000)
  } catch (e) {
    embeddingError.value = (e instanceof Error ? e.message : String(e)) || '保存失败'
  } finally {
    embeddingSaving.value = false
  }
}
async function testEmbedding() {
  embTest.loading = true; embTest.msg = ''
  try {
    const res = await adminStore.authFetch('/api/v1/admin/config/test-embedding', {
      method: 'POST',
      body: JSON.stringify({
        provider:   embeddingDraft.provider || '',
        multimodal: !!embeddingDraft.multimodal,
        base_url:   embeddingDraft.base_url || '',   // 留空=用已存配置
        api_key:    embeddingDraft.api_key || '',
        model:      embeddingDraft.model || '',
        dimensions: embeddingDraft.dimensions || 0,
      }),
    })
    const data = await res.json()
    embTest.ok = !!data.ok
    embTest.msg = data.message || (data.ok ? 'OK' : '失败')
  } catch (e) {
    embTest.ok = false
    embTest.msg = '请求失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    embTest.loading = false
  }
}

// 向量重建（换模型后批量重算，后台跑 + 轮询进度）
const rebuild = reactive({ running: false, done: 0, total: 0, msg: '', error: false })
let rebuildTimer: ReturnType<typeof setInterval> | null = null
function stopRebuildPoll() { if (rebuildTimer) { clearInterval(rebuildTimer); rebuildTimer = null } }
async function pollRebuild() {
  try {
    const res = await adminStore.authFetch('/api/v1/admin/config/embedding-rebuild/status')
    const d = await res.json()
    if (d.status === 'running') {
      rebuild.running = true; rebuild.done = d.done || 0; rebuild.total = d.total || 0
      rebuild.msg = `重建中 ${rebuild.done}/${rebuild.total}`; rebuild.error = false
      if (!rebuildTimer) rebuildTimer = setInterval(pollRebuild, 2000)   // 自续轮询（含页面重载接续）
    } else if (d.status === 'done') {
      rebuild.running = false; rebuild.error = false
      rebuild.msg = `完成：重算了 ${d.done || 0} 个用户的 pattern + 长期记忆向量（${d.with_facts || 0} 个有 pattern）`
      stopRebuildPoll()
    } else if (d.status === 'error') {
      rebuild.running = false; rebuild.error = true; rebuild.msg = '失败：' + (d.message || '')
      stopRebuildPoll()
    } else {
      rebuild.running = false; stopRebuildPoll()
    }
  } catch { /* 忽略单次轮询失败 */ }
}
async function startRebuild() {
  rebuild.msg = ''; rebuild.error = false
  try {
    const res = await adminStore.authFetch('/api/v1/admin/config/embedding-rebuild', { method: 'POST' })
    const d = await res.json()
    if (d.ok) {
      rebuild.running = true; rebuild.total = d.total || 0; rebuild.done = 0
      rebuild.msg = `已启动，共 ${d.total} 个用户`
    } else {
      rebuild.error = true; rebuild.msg = d.message || '启动失败'
    }
    pollRebuild()   // 拉一次进度；若在跑会自启轮询
  } catch (e) {
    rebuild.error = true; rebuild.msg = '请求失败：' + (e instanceof Error ? e.message : String(e))
  }
}

// ── 记忆维护：pattern.json 批量复核清理（先预览再确认，见 backend scripts/refresh_memory.py）──
interface MemCleanupPlanItem {
  removed_ids?: string[]; removed_texts?: string[]
  moved_ids?: string[]; moved_texts?: string[]
  profile_event_migrated?: number; profile_event_texts?: string[]
  daily_migrated?: number; daily_texts?: string[]
  legacy_files?: string[]
  total?: number; error?: string
}
const memCleanup = reactive({
  running: false, done: 0, total: 0, msg: '', error: false,
  status: 'idle' as 'idle' | 'running' | 'done',
  plan: {} as Record<string, MemCleanupPlanItem>,
  expanded: false, applying: false, applyError: false, applyMsg: '',
})
let memCleanupTimer: ReturnType<typeof setInterval> | null = null
function stopMemCleanupPoll() { if (memCleanupTimer) { clearInterval(memCleanupTimer); memCleanupTimer = null } }
const memCleanupUserCount = computed(() => Object.values(memCleanup.plan).filter(p =>
  (p.removed_texts?.length ?? 0) > 0 || (p.moved_texts?.length ?? 0) > 0 ||
  (p.profile_event_texts?.length ?? 0) > 0 || (p.daily_texts?.length ?? 0) > 0 || (p.legacy_files?.length ?? 0) > 0).length)
const memCleanupTotalRemoved = computed(() => Object.values(memCleanup.plan).reduce((n, p) => n + (p.removed_texts?.length ?? 0), 0))
const memCleanupTotalMoved = computed(() => Object.values(memCleanup.plan).reduce((n, p) => n + (p.moved_texts?.length ?? 0), 0))
const memCleanupTotalProfileEvents = computed(() => Object.values(memCleanup.plan).reduce((n, p) => n + (p.profile_event_migrated ?? 0), 0))
const memCleanupTotalDaily = computed(() => Object.values(memCleanup.plan).reduce((n, p) => n + (p.daily_migrated ?? 0), 0))
const memCleanupTotalLegacy = computed(() => Object.values(memCleanup.plan).reduce((n, p) => n + (p.legacy_files?.length ?? 0), 0))
const memCleanupApplyMsg = computed(() => memCleanup.applyMsg)

async function pollMemCleanup() {
  try {
    const res = await adminStore.authFetch('/api/v1/admin/config/memory-cleanup/status')
    const d = await res.json()
    memCleanup.status = d.status ?? 'idle'
    if (d.status === 'running') {
      memCleanup.running = true; memCleanup.done = d.done || 0; memCleanup.total = d.total || 0
      memCleanup.msg = `预览中 ${memCleanup.done}/${memCleanup.total}`; memCleanup.error = false
      if (!memCleanupTimer) memCleanupTimer = setInterval(pollMemCleanup, 2000)
    } else if (d.status === 'done') {
      memCleanup.running = false; memCleanup.error = false
      memCleanup.plan = d.plan || {}
      memCleanup.msg = `预览完成（共 ${d.total || 0} 个用户）`
      stopMemCleanupPoll()
    } else {
      memCleanup.running = false; stopMemCleanupPoll()
    }
  } catch { /* 忽略单次轮询失败 */ }
}
async function startMemCleanupPreview() {
  memCleanup.msg = ''; memCleanup.error = false; memCleanup.applyMsg = ''; memCleanup.expanded = false
  try {
    const res = await adminStore.authFetch('/api/v1/admin/config/memory-cleanup/preview', { method: 'POST' })
    const d = await res.json()
    if (d.ok) {
      memCleanup.running = true; memCleanup.total = d.total || 0; memCleanup.done = 0
      memCleanup.status = 'running'
      memCleanup.msg = `已启动，共 ${d.total} 个用户`
    } else {
      memCleanup.error = true; memCleanup.msg = d.message || '启动失败'
    }
    pollMemCleanup()
  } catch (e) {
    memCleanup.error = true; memCleanup.msg = '请求失败：' + (e instanceof Error ? e.message : String(e))
  }
}
async function applyMemCleanup() {
  if (!confirm(`确定要删 ${memCleanupTotalRemoved.value} 条、搬 ${memCleanupTotalMoved.value} 条去画像、迁 ${memCleanupTotalProfileEvents.value} 条画像事件到 memory、迁 ${memCleanupTotalDaily.value} 条 daily、清 ${memCleanupTotalLegacy.value} 个遗留文件吗？删除/搬动不可恢复。`)) return
  memCleanup.applying = true; memCleanup.applyMsg = ''; memCleanup.applyError = false
  try {
    const res = await adminStore.authFetch('/api/v1/admin/config/memory-cleanup/apply', { method: 'POST' })
    const d = await res.json()
    if (d.ok) {
      memCleanup.applyMsg = `完成：删 ${d.total_removed} 条 / 搬 ${d.total_moved} 条 / 迁 ${d.total_profile_events_migrated} 条画像事件 / 迁 ${d.total_daily_migrated} 条 daily / 清 ${d.legacy_files_removed} 个文件（共 ${d.users_applied} 个用户）`
      memCleanup.plan = {}; memCleanup.status = 'idle'; memCleanup.expanded = false
    } else {
      memCleanup.applyError = true; memCleanup.applyMsg = d.detail || d.message || '执行失败'
    }
  } catch (e) {
    memCleanup.applyError = true; memCleanup.applyMsg = '请求失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    memCleanup.applying = false
  }
}

interface ImMemoryPlatformSummary { platform: string; scopes: number; groups: number; members: number; entries: number }
interface ImMemorySummary {
  total_scopes: number; groups: number; members: number; total_entries: number
  pending_jobs: number; needs_maintenance: number; failed_jobs: number; platforms: ImMemoryPlatformSummary[]
}
const imScopes = reactive({
  loading: false,
  error: '',
  message: '',
  summary: { total_scopes: 0, groups: 0, members: 0, total_entries: 0, pending_jobs: 0, needs_maintenance: 0, failed_jobs: 0, platforms: [] } as ImMemorySummary,
  applying: false,
})
const imModelPreview = reactive({ hasRun: false, running: false, message: '', done: 0, total: 0, needsReview: 0, failed: 0, planReady: false })
let imModelPreviewTimer: ReturnType<typeof setInterval> | null = null
function stopImModelPreviewPoll() {
  if (imModelPreviewTimer !== null) {
    clearInterval(imModelPreviewTimer)
    imModelPreviewTimer = null
  }
}
async function pollImModelPreview() {
  try {
    const res = await adminStore.authFetch('/api/v1/admin/agent/memory/im-scopes/maintenance/model-preview/status')
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || data.message || '读取模型预览失败')
    imModelPreview.running = data.status === 'running'
    imModelPreview.done = Number(data.done || 0)
    imModelPreview.total = Number(data.total || 0)
    imModelPreview.needsReview = Number(data.needs_review || 0)
    imModelPreview.failed = Number(data.failed || 0)
    imModelPreview.planReady = data.plan_ready === undefined
      ? data.status === 'done' && imModelPreview.needsReview > 0
      : Boolean(data.plan_ready)
    if (imModelPreview.running) {
      imModelPreview.message = `模型预览中 ${imModelPreview.done}/${imModelPreview.total}`
    } else if (data.status === 'done') {
      imModelPreview.hasRun = true
      imModelPreview.message = `模型预览完成：${imModelPreview.needsReview} 个作用域有可提炼内容${imModelPreview.failed ? `，失败 ${imModelPreview.failed} 个` : ''}`
      stopImModelPreviewPoll()
      await loadImScopes()
    }
  } catch (error) {
    imModelPreview.running = false
    imModelPreview.message = error instanceof Error ? error.message : '读取模型预览失败'
    stopImModelPreviewPoll()
  }
}
function startImModelPreviewPoll() {
  stopImModelPreviewPoll()
  void pollImModelPreview()
  imModelPreviewTimer = setInterval(() => void pollImModelPreview(), 1500)
}
async function startImModelPreview() {
  imModelPreview.hasRun = false
  imModelPreview.planReady = false
  imModelPreview.message = ''
  try {
    const res = await adminStore.authFetch('/api/v1/admin/agent/memory/im-scopes/maintenance/model-preview', { method: 'POST' })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || data.message || '启动模型预览失败')
    if (!data.ok) {
      imModelPreview.message = data.message || '已有模型预览正在运行'
      imModelPreview.running = true
    } else {
      imModelPreview.running = true
      imModelPreview.message = `已启动模型预览，共 ${data.total || 0} 个作用域`
    }
    startImModelPreviewPoll()
  } catch (error) {
    imModelPreview.running = false
    imModelPreview.message = error instanceof Error ? error.message : '启动模型预览失败'
  }
}
async function loadImScopes() {
  imScopes.loading = true; imScopes.error = ''; imScopes.message = ''
  try {
    const res = await adminStore.authFetch('/api/v1/admin/agent/memory/im-scopes/maintenance/preview', { method: 'POST' })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || data.message || '加载失败')
    imScopes.summary = {
      total_scopes: data.total_scopes || 0, groups: data.groups || 0, members: data.members || 0,
      total_entries: data.total_entries || 0, pending_jobs: data.pending_jobs || 0,
      needs_maintenance: data.needs_maintenance || 0, failed_jobs: data.failed_jobs || 0, platforms: data.platforms || [],
    }
  } catch (error) {
    imScopes.error = error instanceof Error ? error.message : '加载失败'
  } finally {
    imScopes.loading = false
  }
}
async function applyImMemoryMaintenance() {
  if (!confirm('确定整理全部 IM 记忆中尚未反思的消息吗？不会删除已有记忆。')) return
  imScopes.applying = true; imScopes.error = ''; imScopes.message = ''
  try {
    const res = await adminStore.authFetch('/api/v1/admin/agent/memory/im-scopes/maintenance/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || '执行整理失败')
    imModelPreview.planReady = false
    const applied = Number(data.applied || 0)
    imScopes.message = `已应用 ${applied} 个模型预览结果`
    imScopes.applying = false
    await loadImScopes()
    imScopes.message = `已应用 ${applied} 个模型预览结果`
  } catch (error) {
    imScopes.error = error instanceof Error ? error.message : '执行整理失败'
    imScopes.applying = false
  }
}

// ── 搜索连通测试（SearXNG / Tavily）──
const searchTest = reactive({
  searxng:        { loading: false, ok: false, msg: '' },
  searxng_images: { loading: false, ok: false, msg: '' },
  tavily:         { loading: false, ok: false, msg: '' },
  baidu_similar_images: { loading: false, ok: false, msg: '' },
})
async function testSearch(target: 'searxng' | 'searxng_images' | 'tavily' | 'baidu_similar_images') {
  const t = searchTest[target]
  t.loading = true; t.msg = ''
  try {
    const payload = target === 'tavily'
      ? { target, tavily_api_key: generalSearchDraft.tavily_api_key || '' }   // 留空=用已存 key
      : target === 'baidu_similar_images'
        ? { target, baidu_qianfan_api_key: similarImageDraft.baidu_qianfan_api_key || '' }
      : target === 'searxng_images'
        ? { target, searxng_url: generalSearchDraft.searxng_url || '', searxng_image_engines: generalSearchDraft.searxng_image_engines || '' }
        : { target, searxng_url: generalSearchDraft.searxng_url || '', searxng_engines: generalSearchDraft.searxng_engines || '' }
    const res = await adminStore.authFetch('/api/v1/admin/config/test-search', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    const data = await res.json()
    t.ok = !!data.ok
    t.msg = data.message || (data.ok ? 'OK' : '失败')
  } catch (e) {
    t.ok = false
    t.msg = '请求失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    t.loading = false
  }
}

async function saveSearch(source: 'general' | 'similar') {
  const similar = source === 'similar'
  const saving = similar ? similarImageSaving : generalSearchSaving
  const saved = similar ? similarImageSaved : generalSearchSaved
  const error = similar ? similarImageError : generalSearchError
  saving.value = true
  saved.value = false
  error.value = ''
  try {
    await configStore.saveConfig({
      search: similar ? { ...similarImageDraft } : { ...generalSearchDraft },
    })
    saved.value = true
    // key 保存后后端返回 ****，清空输入回到「不修改」态
    if (similar) resetSimilarImageSearch()
    else resetGeneralSearch()
    setTimeout(() => { saved.value = false }, 3000)
  } catch (e) {
    error.value = (e instanceof Error ? e.message : String(e))
    setTimeout(() => { error.value = '' }, 5000)
  } finally {
    saving.value = false
  }
}

// ── 用量统计 ──────────────────────────────────────────────────────────────
const usage        = ref<any | null>(null)
const usageLoading = ref(false)

const activeModel = ref<any | null>(null)

async function fetchUsage(month: any = undefined, model: any = activeModel.value) {
  usageLoading.value = true
  try {
    const params = new URLSearchParams()
    if (month) params.set('month', month)
    if (model) params.set('model', model)
    const qs = params.toString()
    const url = `/api/v1/admin/agent/usage${qs ? '?' + qs : ''}`
    const res = await adminStore.authFetch(url)
    usage.value = await res.json()
  } finally {
    usageLoading.value = false
  }
}

function toggleModel(model: any) {
  activeModel.value = activeModel.value === model ? null : model
  fetchUsage(usage.value?.month, activeModel.value)
}

function fmtNum(n: number) {
  if (n == null) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

// ── 折线图 ────────────────────────────────────────────────────────────────
const CHART_H = 240
const PAD_L   = 40
const PAD_R   = 12
const PAD_T   = 14
const PAD_B   = 28

const CHART_W    = ref(600)
const activeMetric = ref('calls')
const hoverIdx     = ref(-1)
const chartWrap    = ref<HTMLElement | null>(null)

onMounted(() => {
  const ro = new ResizeObserver(entries => {
    CHART_W.value = entries[0].contentRect.width || 600
  })
  watch(chartWrap, el => { if (el) ro.observe(el) }, { immediate: true })
})

const metrics = [
  { key: 'calls',      label: '对话次数', unit: '次' },
  { key: 'tokens_in',  label: '输入 tokens', unit: '' },
  { key: 'tokens_out', label: '输出 tokens', unit: '' },
]

const monthIndex = computed(() => {
  if (!usage.value?.months) return 0
  return usage.value.months.indexOf(usage.value.month)
})

async function switchMonth(dir: number) {
  if (!usage.value?.months) return
  const idx = monthIndex.value + dir
  if (idx < 0 || idx >= usage.value.months.length) return
  await fetchUsage(usage.value.months[idx], activeModel.value)
}

const chartPoints = computed(() => {
  if (!usage.value?.daily) return []
  const data = usage.value.daily
  const vals = data.map((d: any) => d[activeMetric.value] ?? 0)
  const maxV = Math.max(...vals, 1)
  const n    = data.length
  const w    = CHART_W.value
  const xStep = (w - PAD_L - PAD_R) / Math.max(n - 1, 1)
  return vals.map((v: any, i: number) => ({
    x: PAD_L + i * xStep,
    y: PAD_T + (1 - v / maxV) * (CHART_H - PAD_T - PAD_B),
  }))
})

function smoothPath(pts: any[]) {
  if (pts.length < 2) return ''
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`
  for (let i = 1; i < pts.length; i++) {
    const cpx = ((pts[i - 1].x + pts[i].x) / 2).toFixed(1)
    d += ` C ${cpx} ${pts[i-1].y.toFixed(1)} ${cpx} ${pts[i].y.toFixed(1)} ${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)}`
  }
  return d
}

const linePath = computed(() => smoothPath(chartPoints.value))

const fillPath = computed(() => {
  const pts = chartPoints.value
  if (pts.length < 2) return ''
  const base = CHART_H - PAD_B
  return `${smoothPath(pts)} L ${pts[pts.length-1].x.toFixed(1)} ${base} L ${pts[0].x.toFixed(1)} ${base} Z`
})

const gridYs = computed(() => {
  const steps = 4
  return Array.from({ length: steps + 1 }, (_, i) =>
    PAD_T + (i / steps) * (CHART_H - PAD_T - PAD_B)
  )
})

const gridValues = computed(() => {
  if (!usage.value?.daily) return []
  const vals = usage.value.daily.map((d: any) => d[activeMetric.value] ?? 0)
  const maxV = Math.max(...vals, 1)
  const steps = 4
  return Array.from({ length: steps + 1 }, (_, i) =>
    Math.round(maxV * (1 - i / steps))
  )
})

const xLabels = computed(() => {
  const pts  = chartPoints.value
  const data = usage.value?.daily ?? []
  if (!pts.length) return []
  const step = Math.ceil(pts.length / 7)
  return pts
    .map((pt: any, i: number) => ({ x: pt.x, label: data[i]?.date?.slice(8) ?? '' }))
    .filter((_: any, i: number) => i % step === 0 || i === pts.length - 1)
})

const chartRight = computed(() => CHART_W.value - PAD_R)

const hoverColW = computed(() => {
  const n = chartPoints.value.length
  const w = CHART_W.value
  return n > 1 ? (w - PAD_L - PAD_R) / (n - 1) : w - PAD_L - PAD_R
})

const tooltipStyle = computed(() => {
  const pt = hoverIdx.value >= 0 ? chartPoints.value[hoverIdx.value] : null
  if (!pt) return {}
  const w   = CHART_W.value
  const pct = (pt.x - PAD_L) / (w - PAD_L - PAD_R)
  return {
    left: `${Math.min(Math.max(pct * 100, 8), 75)}%`,
    top:  `${Math.max(4, (pt.y - PAD_T) / (CHART_H - PAD_T - PAD_B) * 72)}%`,
  }
})

// ── 初始化 ────────────────────────────────────────────────────────────────
onMounted(async () => {
  await configStore.fetchConfig()
  Object.assign(agentDraft, configStore.cfg.agent)
  resetGeneralSearch()
  resetSimilarImageSearch()
  Object.assign(voiceDraft, configStore.cfg.voice)
  Object.assign(embeddingDraft, configStore.cfg.embedding)
  fetchPresets()
  pollRebuild()   // 若有重建任务在跑，页面加载即反映进度并接续轮询
  pollMemCleanup()   // 同理：若有记忆清理预览在跑/已完成，页面加载即反映
})

onUnmounted(() => { stopRebuildPoll(); stopMemCleanupPoll(); stopImModelPreviewPoll() })
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
.tab-bar {
  display: flex;
  gap: 4px;
  padding: 18px 36px 0;
  flex-shrink: 0;
}
.tab-btn {
  padding: 7px 18px;
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.08);
  background: rgba(255,255,255,0.04);
  font-size: 13px;
  font-weight: 500;
  color: rgba(255,255,255,0.35);
  cursor: pointer;
  transition: all 0.15s;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
}
.tab-btn::after {
  content: attr(data-label);
  font-weight: 600;
  height: 0;
  overflow: hidden;
  visibility: hidden;
  pointer-events: none;
}
.tab-btn:hover:not(.active) {
  background: rgba(255,255,255,0.07);
  color: rgba(255,255,255,0.6);
}
.tab-btn.active {
  background: rgba(123,127,178,0.18);
  border-color: rgba(123,127,178,0.32);
  color: rgba(255,255,255,0.9);
  font-weight: 600;
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
/* ── Provider 切换 ── */
.toggle-group { display: flex; gap: 6px; margin-bottom: 16px; flex-wrap: wrap; }
.provider-grid { }
.profile-switcher { display: flex; gap: 6px; margin-left: auto; }
.toggle-btn {
  padding: 6px 16px; border-radius: 9px;
  border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05);
  font-size: 13px; font-weight: 500; color: rgba(255,255,255,0.38);
  cursor: pointer; transition: all 0.15s;
  display: inline-flex; flex-direction: column; align-items: center; justify-content: center;
}
.toggle-btn::after {
  content: attr(data-label);
  font-weight: 600;
  height: 0; overflow: hidden; visibility: hidden; pointer-events: none;
}
.toggle-btn.active {
  background: rgba(123,127,178,0.2); border-color: rgba(123,127,178,0.35);
  color: rgba(255,255,255,0.88); font-weight: 600;
}
.toggle-btn:hover:not(.active) { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.6); }

/* ── 字段网格 ── */
.field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.field-grid :deep(.span2) { grid-column: span 2; }

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
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  color: white; font-size: 13px; font-weight: 600;
  cursor: pointer; transition: opacity 0.15s;
  box-shadow: 0 2px 8px rgba(123,127,178,0.18);
}
.btn-primary:hover:not(:disabled) { opacity: 0.88; }
.btn-primary:disabled { opacity: 0.5; cursor: default; }

/* ── 提示词编辑器 ── */
.prompts-card .card-head { align-items: flex-start; }
.prompt-editor-wrap {
  display: grid;
  grid-template-columns: 1fr 200px;
  gap: 14px;
  min-height: 380px;
}
.prompt-textarea {
  width: 100%;
  min-height: 380px;
  background: rgba(0,0,0,0.25);
  border: 1px solid rgba(255,255,255,0.09);
  border-radius: 10px;
  padding: 14px 16px;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 13px;
  line-height: 1.7;
  color: rgba(255,255,255,0.82);
  resize: vertical;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.15s;
}
.prompt-textarea:focus {
  border-color: rgba(123,127,178,0.4);
}
.prompt-textarea::placeholder { color: rgba(255,255,255,0.2); }
/* 暗色滚动条 + 去掉右下角横竖交汇处的白块（scrollbar-corner 默认是白的） */
.prompt-textarea { scrollbar-color: rgba(255,255,255,0.18) transparent; }  /* Firefox */

.placeholder-panel {
  display: flex; flex-direction: column; gap: 6px;
}
.placeholder-title {
  font-size: 11px; font-weight: 600; letter-spacing: 0.07em;
  color: rgba(255,255,255,0.25); text-transform: uppercase;
  margin-bottom: 2px;
}
.placeholder-item {
  display: flex; flex-direction: column; gap: 2px;
  padding: 8px 10px; border-radius: 8px;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.07);
  cursor: pointer; transition: all 0.15s;
}
.placeholder-item:hover {
  background: rgba(123,127,178,0.12);
  border-color: rgba(123,127,178,0.25);
}
.placeholder-item code {
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 12px; color: rgba(149,144,196,0.9);
}
.placeholder-item span {
  font-size: 11px; color: rgba(255,255,255,0.3);
}

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

.mem-cleanup-detail {
  max-height: 260px; overflow-y: auto;
  padding: 10px 12px; border-radius: 8px;
  background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08);
}
.mem-cleanup-uid {
  font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.5);
  margin: 10px 0 4px; font-family: 'SF Mono','Consolas',monospace;
}
.mem-cleanup-uid:first-child { margin-top: 0; }
.mem-cleanup-text { font-size: 12px; color: rgba(255,255,255,0.65); line-height: 1.6; padding-left: 4px; }

.toggle-switch {
  width: 42px; height: 24px; border-radius: 99px;
  background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.12);
  position: relative; cursor: pointer; transition: all 0.2s; flex-shrink: 0;
}
.toggle-switch.on {
  background: rgba(123,127,178,0.5); border-color: rgba(123,127,178,0.6);
}
.toggle-knob {
  position: absolute; top: 3px; left: 3px;
  width: 16px; height: 16px; border-radius: 50%;
  background: rgba(255,255,255,0.6);
  transition: transform 0.2s cubic-bezier(0.34, 1.2, 0.64, 1);
}
.toggle-switch.on .toggle-knob {
  transform: translateX(18px);
  background: white;
}

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

/* ── 用量统计 ── */
.usage-loading, .usage-empty {
  text-align: center; padding: 64px 0;
  font-size: 13px; color: rgba(255,255,255,0.2);
}

.usage-summary {
  display: grid; grid-template-columns: repeat(3, 1fr);
  gap: 12px; margin-bottom: 12px;
}
.usage-stat-card {
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.09); border-radius: 14px;
  padding: 20px 22px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.06);
}
.usc-label { font-size: 11px; color: rgba(255,255,255,0.3); font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 10px; }
.usc-num   { font-size: 28px; font-weight: 700; color: rgba(255,255,255,0.88); line-height: 1; }
.usc-sub   { font-size: 12px; color: rgba(255,255,255,0.25); margin-top: 6px; }

/* ── 折线图 ── */
.chart-card { margin-bottom: 12px; }
.chart-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 16px;
}
.metric-tabs { display: flex; gap: 4px; }
.metric-tab {
  padding: 5px 14px; border-radius: 8px; font-size: 12px; font-weight: 500;
  border: 1px solid rgba(255,255,255,0.09); background: rgba(255,255,255,0.04);
  color: rgba(255,255,255,0.35); cursor: pointer; transition: all 0.15s;
  display: inline-flex; flex-direction: column; align-items: center;
}
.metric-tab::after {
  content: attr(data-label);
  font-weight: 600;
  height: 0; overflow: hidden; visibility: hidden; pointer-events: none;
}
.metric-tab.active {
  background: rgba(123,127,178,0.2); border-color: rgba(123,127,178,0.35);
  color: rgba(255,255,255,0.88);
}
.metric-tab:hover:not(.active) { background: rgba(255,255,255,0.07); color: rgba(255,255,255,0.6); }

.month-nav { display: flex; align-items: center; gap: 8px; }
.month-label { font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.7); min-width: 64px; text-align: center; }
.month-arrow {
  width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center;
  border: 1px solid rgba(255,255,255,0.09); background: rgba(255,255,255,0.05);
  color: rgba(255,255,255,0.5); cursor: pointer; transition: all 0.15s;
}
.month-arrow svg { width: 14px; height: 14px; }
.month-arrow:hover:not(:disabled) { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.85); }
.month-arrow:disabled { opacity: 0.3; cursor: default; }

.chart-wrap { position: relative; width: 100%; }
.line-chart { display: block; overflow: visible; }

.chart-tooltip {
  position: absolute; pointer-events: none;
  background: rgba(16,16,26,0.95);
  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(149,144,196,0.25); border-radius: 10px;
  padding: 9px 14px; transform: translate(-50%, -115%);
  white-space: nowrap;
  box-shadow: 0 4px 20px rgba(0,0,0,0.4);
}
.tt-date { font-size: 11px; color: rgba(255,255,255,0.35); margin-bottom: 4px; letter-spacing: 0.04em; }
.tt-val  { font-size: 18px; font-weight: 700; color: rgba(255,255,255,0.92); line-height: 1; }
.tt-val span { font-size: 11px; font-weight: 400; color: rgba(255,255,255,0.35); margin-left: 3px; }

.tt-enter-active, .tt-leave-active { transition: opacity 0.1s, transform 0.1s; }
.tt-enter-from, .tt-leave-to { opacity: 0; transform: translate(-50%, -105%); }

.model-table { display: flex; flex-direction: column; gap: 0; }
.mt-row {
  display: grid; grid-template-columns: 1fr 80px 90px 90px;
  padding: 10px 4px; font-size: 13px;
  border-bottom: 1px solid rgba(255,255,255,0.05);
  align-items: center;
  transition: background 0.15s, opacity 0.15s;
  border-radius: 8px;
}
.mt-row:last-child { border-bottom: none; }
.mt-head { font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.25); text-transform: uppercase; letter-spacing: 0.06em; }
.mt-clickable { cursor: pointer; }
.mt-clickable:hover { background: rgba(255,255,255,0.04); }
.mt-active { background: rgba(123,127,178,0.12) !important; }
.mt-active .mt-model { color: rgba(169,164,216,0.95); }
.mt-dimmed { opacity: 0.35; }
.mt-model { color: rgba(255,255,255,0.8); font-weight: 500; }
.mt-model em { display: block; font-style: normal; font-size: 11px; color: rgba(255,255,255,0.28); margin-top: 2px; }
.mt-row span:not(:first-child) { color: rgba(255,255,255,0.55); text-align: right; }

.model-filter-tag {
  display: inline-flex; align-items: center;
  padding: 3px 10px; border-radius: 6px;
  background: rgba(123,127,178,0.18); border: 1px solid rgba(123,127,178,0.3);
  font-size: 12px; color: rgba(169,164,216,0.9);
  margin-left: 6px; max-width: 200px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.clear-model-btn {
  display: inline-flex; align-items: center; gap: 5px;
  margin-left: auto;
  padding: 5px 12px; border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05);
  font-size: 12px; color: rgba(255,255,255,0.4);
  cursor: pointer; transition: all 0.15s;
}
.clear-model-btn:hover { background: rgba(255,255,255,0.09); color: rgba(255,255,255,0.7); }

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
.api-format-grid { display: flex; gap: 8px; flex-wrap: wrap; }
.api-format-grid .toggle-btn { flex: 1; min-width: 0; white-space: nowrap; }

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
/* key 独占整行、过长截断带省略号（悬停看全文），不再撑破页面宽度 */
.preset-key   { flex: 1 1 100%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 11px; color: rgba(255,255,255,0.28); font-family: 'SF Mono', ui-monospace, monospace; }

.preset-card-actions { display: flex; gap: 6px; align-items: center; flex-shrink: 0; }
.pca-btn {
  padding: 5px 12px; border-radius: 8px; font-size: 12px; font-weight: 500;
  border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05);
  color: rgba(255,255,255,0.5); cursor: pointer; transition: all 0.15s;
}
.pca-btn:hover { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.75); }
.pca-btn--sm { padding: 4px 10px; font-size: 11px; }
.pca-btn:disabled { opacity: 0.5; cursor: default; }

/* ── 频道：飞书回调地址 ── */
.bots-redirect {
  margin: 4px 0 16px; padding: 14px 16px;
  background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 12px;
}
.bots-redirect-head { display: flex; flex-direction: column; gap: 3px; margin-bottom: 10px; }
.bots-redirect-title { font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.85); }
.bots-redirect-hint { font-size: 11px; color: rgba(255,255,255,0.4); }
.bots-redirect-row { display: flex; gap: 8px; align-items: center; }

/* ── 频道：卡片网格 ── */
.bots-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}
.bot-card {
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 14px; padding: 14px 16px;
  display: flex; flex-direction: column; gap: 5px;
  transition: opacity 0.2s;
}
.bot-card--off { opacity: 0.45; }
.bot-card-top { display: flex; align-items: center; justify-content: space-between; }
.bot-plat {
  font-size: 11px; font-weight: 600; color: rgba(150,160,220,0.95);
  background: rgba(123,127,178,0.16); padding: 2px 8px; border-radius: 6px;
}
.bot-status { font-size: 11px; color: rgba(255,255,255,0.4); }
.bot-status.on { color: #74c69d; }
.bot-name { font-size: 14px; font-weight: 600; color: rgba(255,255,255,0.9); }
.bot-appid {
  font-size: 11px; color: rgba(255,255,255,0.38);
  font-family: 'SF Mono','Consolas',monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bot-card-actions { display: flex; gap: 6px; margin-top: 8px; justify-content: flex-end; }
.bot-card-actions .btn-ghost { font-size: 12px; padding: 4px 10px; }
.bot-del { color: #d88; }

/* ── 频道弹窗：飞书事件订阅 Webhook 区 ── */
.bot-webhook-sep {
  margin: 16px 0 4px; font-size: 11px; color: rgba(255,255,255,0.4);
  border-top: 1px solid rgba(255,255,255,0.08); padding-top: 12px;
}
.bot-webhook-url {
  display: flex; align-items: center; gap: 8px;
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px; padding: 7px 10px;
}
.bot-webhook-url code {
  flex: 1; font-size: 11.5px; color: rgba(150,200,220,0.95);
  font-family: 'SF Mono','Consolas',monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  user-select: all;   /* 复制兜底失败时，点一下即可全选手动复制 */
}
.bot-webhook-url .tb-copy {
  flex-shrink: 0; font-size: 11px; padding: 3px 10px; border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.06);
  color: rgba(255,255,255,0.6); cursor: pointer; transition: all 0.15s;
}
.bot-webhook-url .tb-copy:hover { background: rgba(255,255,255,0.12); color: rgba(255,255,255,0.85); }
.bot-webhook-hint { font-size: 11.5px; color: rgba(255,255,255,0.35); padding: 2px 0; }

/* ── 频道编辑表单 ── */
.bot-edit-card { padding: 18px 20px; max-width: 480px; }
.bot-edit-title { font-size: 14px; font-weight: 600; color: rgba(255,255,255,0.88); margin: 0 0 14px; }
.bot-form { display: flex; flex-direction: column; gap: 12px; max-width: 400px; }
.bot-field { display: flex; flex-direction: column; gap: 5px; }
.bot-field > span { font-size: 12px; color: rgba(255,255,255,0.55); }
.bot-field > span em { font-style: normal; color: rgba(255,255,255,0.32); margin-left: 6px; }
.bot-field--row { flex-direction: row; align-items: center; justify-content: space-between; }
.bot-input {
  width: 100%; box-sizing: border-box;
  background: rgba(0,0,0,0.22); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px; padding: 8px 11px; font-size: 13px;
  color: rgba(255,255,255,0.85); outline: none;
  transition: border-color 0.15s;
}
.bot-input:focus { border-color: rgba(123,127,178,0.5); }
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

/* ── 编辑 Modal ── */
.modal-mask {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(0,0,0,0.5); backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
}
.modal-box {
  width: 640px; max-width: 92vw;
  max-height: calc(100vh - 48px); overflow-y: auto;
  background: rgba(22,22,34,0.97);
  backdrop-filter: blur(32px); -webkit-backdrop-filter: blur(32px);
  border: 1px solid rgba(255,255,255,0.1); border-radius: 18px;
  padding: 24px 28px 18px;
  box-shadow: 0 24px 80px rgba(0,0,0,0.5);
}
.modal-title { font-size: 16px; font-weight: 700; color: rgba(255,255,255,0.88); margin-bottom: 14px; }
.modal-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
.modal-field label { font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.35); text-transform: uppercase; letter-spacing: 0.07em; }
.modal-input {
  width: 100%; padding: 9px 12px; border-radius: 9px;
  background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.1);
  font-size: 13px; color: rgba(255,255,255,0.82); outline: none;
  transition: border-color 0.15s; box-sizing: border-box;
}
.modal-input:focus { border-color: rgba(123,127,178,0.45); }
.modal-input::placeholder { color: rgba(255,255,255,0.2); }
.modal-hint { font-size: 11px; line-height: 1.5; color: rgba(255,255,255,0.45); }
.modal-hint.ollama-mode-warning { color: rgba(242, 190, 126, 0.78); }
.modal-hint code { color: rgba(123,127,178,0.9); background: rgba(123,127,178,0.12); padding: 1px 5px; border-radius: 4px; font-size: 10.5px; word-break: break-all; }
.model-picker { position: relative; }
.model-picker-row { display: flex; gap: 7px; align-items: center; }
.model-picker-row .modal-input { min-width: 0; flex: 1; }
.model-fetch-btn { flex: 0 0 auto; border: 1px solid rgba(123,127,178,0.35); border-radius: 8px;
  padding: 8px 10px; background: rgba(123,127,178,0.12); color: rgba(226,228,247,0.8);
  font-size: 11px; cursor: pointer; white-space: nowrap; }
.model-fetch-btn:hover:not(:disabled) { background: rgba(123,127,178,0.24); }
.model-fetch-btn:disabled { opacity: 0.45; cursor: default; }
.model-options { position: absolute; z-index: 20; left: 0; right: 0; top: calc(100% + 5px);
  max-height: 220px; overflow: auto; padding: 5px; border: 1px solid rgba(255,255,255,0.13);
  border-radius: 9px; background: #242638; box-shadow: 0 12px 30px rgba(0,0,0,0.35); }
.model-option { display: block; width: 100%; border: 0; border-radius: 6px; padding: 7px 9px;
  background: transparent; color: rgba(235,236,248,0.85); text-align: left; font-size: 12px; cursor: pointer; }
.model-option:hover { background: rgba(123,127,178,0.22); }
.model-option-hint { padding: 8px 9px; color: rgba(255,255,255,0.45); font-size: 11px; }
.model-option-hint.error { color: #ffadad; }
.modal-actions {
  display: flex; align-items: center; gap: 10px;
  margin-top: 14px; padding-top: 12px;
  border-top: 1px solid rgba(255,255,255,0.07);
}
.modal-actions .save-hint { flex: 1; }
.modal-field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 10px; }
.modal-field-row .modal-field { margin-bottom: 0; }
.modal-field--row { flex-direction: row; align-items: center; justify-content: space-between; }
.modal-field--row > span { font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.35); letter-spacing: 0.07em; }
.thinking-label { display: flex; flex-direction: column; gap: 3px; }
.thinking-label > span:first-child { font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.35); text-transform: uppercase; letter-spacing: 0.07em; }
.thinking-hint { font-size: 11px; color: rgba(255,255,255,0.2); text-transform: none; letter-spacing: 0; font-weight: 400; }
.preset-meta-item { font-size: 12px; color: rgba(255,255,255,0.35); white-space: nowrap; flex-shrink: 0; }
/* 思考 / 多模态：图标 + 文字横排，不被挤成竖排 */
.preset-meta-think, .preset-meta-vision { display: inline-flex; align-items: center; gap: 3px; }
.preset-meta-think { color: rgba(149,144,196,0.85); background: rgba(149,144,196,0.1); padding: 1px 6px; border-radius: 4px; }
.preset-meta-vision { color: rgba(122,184,200,0.95); background: rgba(122,184,200,0.12); padding: 1px 6px; border-radius: 4px; }
.modal-input[type="number"] { -moz-appearance: textfield; }
.modal-input[type="number"]::-webkit-inner-spin-button,
.modal-input[type="number"]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }

/* ── 决策轨迹 ── */
.capability-catalog-card { min-height: calc(100vh - 230px); }
.capability-catalog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.capability-catalog-summary { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 18px; color: rgba(255,255,255,0.58); font-size: 12px; }
.capability-catalog-summary span { padding: 5px 9px; border: 1px solid rgba(255,255,255,0.08); border-radius: 7px; background: rgba(255,255,255,0.035); }
.capability-catalog-warning { color: #f2be7e; }
.capability-catalog-group { margin-top: 18px; }
.capability-catalog-group h4 { margin: 0 0 9px; color: rgba(255,255,255,0.48); font-size: 12px; font-weight: 600; }
.capability-catalog-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 12px; }
.capability-catalog-item { min-width: 0; padding: 10px 12px; border: 1px solid rgba(255,255,255,0.07); border-radius: 9px; background: rgba(255,255,255,0.025); }
.capability-catalog-item-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.capability-catalog-item code { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #d6d8ee; font-size: 11px; }
.capability-catalog-item-head span { flex: 0 0 auto; color: rgba(255,255,255,0.32); font-size: 10px; }
.capability-catalog-item p { margin: 6px 0 5px; color: rgba(255,255,255,0.68); font-size: 12px; line-height: 1.5; }
.capability-catalog-item small { display: block; overflow: hidden; color: rgba(255,255,255,0.32); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 720px) { .capability-catalog-grid { grid-template-columns: 1fr; } }

.trace-wrap { display: grid; grid-template-columns: 300px 1fr; gap: 14px; height: calc(100vh - 230px); min-height: 420px; }
.trace-list { display: flex; flex-direction: column; gap: 6px; overflow-y: auto; padding-right: 4px; }
.trace-search { display: flex; gap: 6px; position: sticky; top: 0; padding-bottom: 6px; }
.trace-search input { flex: 1; min-width: 0; padding: 7px 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.04); color: #fff; font-size: 12px; }
.trace-search button { padding: 0 12px; border-radius: 8px; border: 1px solid rgba(123,127,178,0.4); background: rgba(123,127,178,0.18); color: #cdd0ee; font-size: 12px; cursor: pointer; }
.trace-search button:hover { background: rgba(123,127,178,0.3); }
.trace-hint { color: rgba(255,255,255,0.3); font-size: 12px; padding: 12px; text-align: center; }
.trace-sess { padding: 9px 11px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.06); background: rgba(255,255,255,0.03); cursor: pointer; transition: background 0.15s, border-color 0.15s; }
.trace-sess:hover { background: rgba(255,255,255,0.06); }
.trace-sess.active { background: rgba(123,127,178,0.16); border-color: rgba(123,127,178,0.45); }
.ts-top { display: flex; align-items: center; gap: 6px; }
.ts-src { flex-shrink: 0; font-size: 10px; padding: 1px 6px; border-radius: 6px; background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.5); }
.ts-src.src-feishu { background: rgba(80,150,255,0.18); color: #9cc0ff; }
.ts-src.src-qq { background: rgba(90,200,160,0.18); color: #8fe0c0; }
.ts-title { font-size: 13px; color: #e8e9f2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ts-meta { font-size: 11px; color: rgba(255,255,255,0.32); margin-top: 3px; }
.trace-detail { overflow-y: auto; border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; background: rgba(255,255,255,0.02); padding: 16px; }
.trace-empty { color: rgba(255,255,255,0.3); font-size: 13px; text-align: center; padding-top: 60px; }
.trace-head { border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 10px; margin-bottom: 14px; }
.th-title { font-size: 15px; font-weight: 600; color: #f0f1f8; }
.th-meta { font-size: 11px; color: rgba(255,255,255,0.4); margin-top: 4px; }
.trace-timeline { display: flex; flex-direction: column; gap: 10px; }
.tstep { display: flex; flex-direction: column; gap: 5px; }
.tstep-role { font-size: 10px; font-weight: 700; letter-spacing: 0.04em; }
.tstep-role.user { color: #c4afc8; }
.tstep-role.ai   { color: #9aa0d8; }
.tstep-text { font-size: 13px; line-height: 1.55; color: #d8d9e6; white-space: pre-wrap; word-break: break-word;
  background: rgba(255,255,255,0.03); border-radius: 8px; padding: 8px 11px; }
.k-user .tstep-text { background: rgba(196,175,200,0.08); }
.tstep-files { font-size: 11px; color: #8fe0c0; }
.k-tool_call, .k-tool_result { padding-left: 14px; border-left: 2px solid rgba(255,255,255,0.08); margin-left: 4px; }
.tstep-tool { display: flex; align-items: center; gap: 8px; }
.tool-badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 6px; }
.tool-badge.call { background: rgba(123,127,178,0.2); color: #b6b9e6; }
.tool-badge.res  { background: rgba(90,180,140,0.15); color: #8fd8b4; }
.tool-badge.res.err { background: rgba(224,85,85,0.18); color: #f0a0a0; }
.tool-toggle { font-size: 11px; color: rgba(255,255,255,0.4); background: none; border: none; cursor: pointer; padding: 2px 4px; }
.tool-toggle:hover { color: rgba(255,255,255,0.7); }
.tool-json { font-size: 11px; line-height: 1.5; color: #c2c4d6; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.06);
  border-radius: 8px; padding: 9px 11px; margin: 0; max-height: 280px; overflow: auto; white-space: pre-wrap; word-break: break-word; }

/* ── 状态命名 ── */
.labels-tip { display: flex; align-items: flex-start; gap: 8px; margin: 0 0 16px; padding: 10px 13px;
  background: rgba(120,170,255,0.09); border: 1px solid rgba(120,170,255,0.22); border-radius: 10px;
  font-size: 12.5px; line-height: 1.6; color: rgba(255,255,255,0.78); }
.labels-tip-icon { flex: 0 0 auto; font-size: 14px; line-height: 1.4; }
.labels-tip b { color: #fff; font-weight: 600; }
.labels-tip code, .card-head code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
  background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); border-radius: 5px; padding: 1px 6px; color: #ffd9a8; }
.labels-group-title { display: flex; align-items: center; gap: 10px; margin: 18px 2px 8px; font-size: 12px; font-weight: 600;
  color: rgba(255,255,255,0.42); text-transform: uppercase; letter-spacing: 0.06em; }
.labels-filter { margin-left: auto; text-transform: none; letter-spacing: 0; font-weight: 400; width: 180px;
  background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.1); border-radius: 7px; padding: 5px 9px; color: #e6e7f0; font-size: 12px; }
.labels-filter:focus { outline: none; border-color: rgba(255,255,255,0.28); }
.labels-list { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; }
.label-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; background: rgba(255,255,255,0.025);
  border: 1px solid rgba(255,255,255,0.06); border-radius: 9px; }
.label-meta { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 0 0 40%; }
.label-key { font-size: 12px; color: #cdd0e4; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; }
.label-default { font-size: 10.5px; color: rgba(255,255,255,0.3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.label-input-wrap { position: relative; flex: 1; min-width: 0; }
.label-input { width: 100%; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.1); border-radius: 7px;
  padding: 6px 26px 6px 9px; color: #e6e7f0; font-size: 12.5px; }
.label-input:focus { outline: none; border-color: rgba(255,255,255,0.3); }
.label-reset { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); width: 18px; height: 18px; line-height: 1;
  border: none; background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.55); border-radius: 50%; cursor: pointer; font-size: 13px; }
.label-reset:hover { background: rgba(255,255,255,0.16); color: #fff; }
.labels-save-bar { display: flex; align-items: center; justify-content: flex-end; gap: 12px; margin-top: 18px;
  padding-top: 14px; border-top: 1px solid rgba(255,255,255,0.07); }
.labels-saved-tip { font-size: 12.5px; color: #7fd6a0; }
.im-memory-summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
.im-memory-summary-grid > div { min-width: 0; padding: 10px 8px; border: 1px solid rgba(255,255,255,0.08); border-radius: 9px; background: rgba(255,255,255,0.035); text-align: center; }
.im-memory-summary-grid strong { display: block; color: #e6e7f0; font-size: 18px; line-height: 1.2; }
.im-memory-summary-grid span { display: block; margin-top: 4px; color: rgba(255,255,255,0.45); font-size: 11px; }
.im-memory-platforms { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 10px; }
.im-memory-platform { padding: 5px 9px; border-radius: 999px; background: rgba(123,127,178,0.14); color: rgba(255,255,255,0.68); font-size: 11px; }
.im-memory-maintenance-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 14px; }
.im-memory-progress { display: flex; gap: 12px; margin-top: 10px; color: rgba(255,255,255,0.55); font-size: 12px; }
.im-memory-progress .error { color: #ff9b9b; }
@media (max-width: 900px) { .im-memory-summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 720px) { .labels-list { grid-template-columns: 1fr; } }
</style>
