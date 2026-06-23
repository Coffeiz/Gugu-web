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

      <!-- ── LLM 预设 ── -->
      <div v-if="activeTab === 'llm'">
        <!-- 标题行 -->
        <div class="presets-header">
          <div>
            <h3 class="presets-title">LLM 预设</h3>
            <p class="presets-desc">管理多套模型配置，随时切换当前生效预设</p>
          </div>
          <button class="btn-primary" @click="openNewPreset">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6.5 1v11M1 6.5h11"/></svg>
            新建预设
          </button>
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
                <span class="preset-meta-item">out {{ p.max_tokens ?? 2000 }}</span>
                <span class="preset-meta-item">ctx {{ p.context_tokens ?? 3000 }}</span>
                <span class="preset-meta-item">temp {{ p.temperature ?? 0.7 }}</span>
                <span v-if="p.thinking === 'adaptive'" class="preset-meta-item preset-meta-think">思考</span>
                <span v-if="p.vision" class="preset-meta-item preset-meta-vision">👁 多模态</span>
                <span class="preset-key">{{ p.api_key || '未设置 Key' }}</span>
              </div>
            </div>
            <div class="preset-card-actions">
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

            <div class="modal-field">
              <label>API Key</label>
              <input v-model="editTarget.api_key" type="password" autocomplete="new-password"
                placeholder="留空表示不修改" class="modal-input" />
            </div>

            <div class="modal-field">
              <label>Base URL</label>
              <input v-model="editTarget.base_url" placeholder="https://…" class="modal-input" />
            </div>

            <div class="modal-field">
              <label>模型名称</label>
              <input v-model="editTarget.model" placeholder="qwen-max" class="modal-input" />
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
                <span class="thinking-hint">仅支持 MiniMax M3 / Anthropic（adaptive 模式）</span>
              </div>
              <button
                class="toggle-switch"
                :class="{ on: editTarget.thinking === 'adaptive' }"
                @click="editTarget.thinking = editTarget.thinking === 'adaptive' ? 'disabled' : 'adaptive'"
              >
                <span class="toggle-knob" />
              </button>
            </div>

            <div class="modal-field modal-field--row">
              <div class="thinking-label">
                <span>多模态（看图）</span>
                <span class="thinking-hint">开启后用户发的图片直接给模型「看」；不确定就用卡片上的「检测多模态」自动判定</span>
              </div>
              <button
                class="toggle-switch"
                :class="{ on: editTarget.vision }"
                @click="editTarget.vision = !editTarget.vision"
              >
                <span class="toggle-knob" />
              </button>
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
            >{{ ({persona:'人格', skills:'工具准则', policy:'内容政策', reflection:'记忆反思', compress:'记忆压缩'})[p.profile] || p.profile }}</button>
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
          ⚠️ 这是<strong>记忆反思提炼词</strong>，决定咕咕每次对话后从中记住什么。改它会影响记忆质量；需保持输出 JSON 格式 <code>{"facts":[...],"daily":"..."}</code>。
        </div>

        <div v-if="activeProfile === 'compress'" class="persona-caution"
          style="margin:0 0 12px;padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.6;min-height:62px;box-sizing:border-box;
                 background:rgba(214,138,90,0.12);border:1px solid rgba(214,138,90,0.3);color:#b07043">
          ⚠️ 这是<strong>记忆压缩提炼词</strong>，决定老的近期记忆怎么沉淀进长期记忆。改它会影响长期记忆质量；需保持输出 JSON 格式 <code>{"memory":"..."}</code>。
        </div>

        <div class="prompt-editor-wrap">
          <textarea
            class="prompt-textarea"
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
          <div class="behavior-item">
            <div class="behavior-label">
              <span>记忆系统</span>
              <span class="behavior-desc">开启后 Agent 将自动从对话中提炼记忆</span>
            </div>
            <button
              class="toggle-switch"
              :class="{ on: agentDraft.memory_enabled }"
              @click="agentDraft.memory_enabled = !agentDraft.memory_enabled"
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
            <p>Tavily 搜索 API，让咕咕能查实时网络信息（每日次数上限在「配额管理」设置）</p>
          </div>
        </div>

        <div class="behavior-grid">
          <div class="behavior-item" style="grid-column: 1 / -1;">
            <div class="behavior-label">
              <span>Tavily API Key</span>
              <span class="behavior-desc">留空表示不修改；清空并保存不会删除已存的 key</span>
            </div>
            <input
              type="password"
              class="behavior-input"
              style="width: 280px;"
              v-model="searchDraft.tavily_api_key"
              placeholder="tvly-… （留空表示不修改）"
              autocomplete="new-password"
            />
          </div>

          <div class="behavior-item">
            <div class="behavior-label">
              <span>默认返回结果数</span>
              <span class="behavior-desc">每次搜索返回多少条结果</span>
            </div>
            <input
              type="number"
              class="behavior-input"
              v-model.number="searchDraft.max_results"
              min="1" max="20"
            />
          </div>
        </div>

        <div class="card-actions">
          <span class="save-hint" :class="{ error: !!searchError }">
            <template v-if="searchSaved"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 6l2.5 2.5 5.5-5"/></svg>已保存</template>
            <template v-else-if="searchError">{{ searchError }}</template>
          </span>
          <button class="btn-ghost" @click="resetSearch">撤销修改</button>
          <button class="btn-primary" :class="{ loading: searchSaving }" :disabled="searchSaving" @click="saveSearch">
            <svg v-if="searchSaving" class="spin-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 1v2M6 9v2M1 6h2M9 6h2"/></svg>
            {{ searchSaving ? '保存中…' : '保存' }}
          </button>
        </div>
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

          <div v-if="!usage.by_model.length && !usage.daily.some(d => d.calls > 0)" class="usage-empty">
            暂无数据，发起对话后将开始记录
          </div>

        </template>
      </div>

    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { useConfigStore } from '@/stores/config'
import { useAdminStore } from '@/stores/admin'
import ConfigField from '../Config/components/ConfigField.vue'

const configStore = useConfigStore()
const adminStore  = useAdminStore()

const tabs = [
  { key: 'llm',      label: 'LLM 配置' },
  { key: 'prompts',  label: '系统提示词' },
  { key: 'behavior', label: '行为配置' },
  { key: 'usage',    label: '用量统计' },
]
const activeTab = ref('llm')

function switchTab(key) {
  activeTab.value = key
  if (key === 'llm'     && presets.value.length === 0) fetchPresets()
  if (key === 'prompts' && profiles.value.length === 0) fetchProfiles()
  if (key === 'usage'   && !usage.value) fetchUsage()
}


// ── LLM 预设 ──────────────────────────────────────────────────────────────
const PROVIDERS = [
  { key: 'openai',    label: 'OpenAI 兼容', base_url: 'https://api.openai.com/v1',                          model: 'gpt-4o' },
  { key: 'anthropic', label: 'Anthropic',   base_url: 'https://api.anthropic.com/v1',                       model: 'claude-opus-4-8' },
  { key: 'qwen',      label: '通义千问',    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-max' },
  { key: 'deepseek',  label: 'DeepSeek',    base_url: 'https://api.deepseek.com',                           model: 'deepseek-chat' },
  { key: 'minimax',   label: 'MiniMax',     base_url: 'https://api.minimaxi.com/anthropic',                 model: 'MiniMax-M3' },
]

const presets        = ref([])
const activePresetId = ref('')
const presetsLoading = ref(false)
const llmMsg         = ref('')
const llmMsgError    = ref(false)
const testingId      = ref(null)
const activatingId   = ref(null)
const probingId      = ref(null)

// edit modal
const editTarget   = ref(null)
const editIsNew    = ref(false)
const editSaving   = ref(false)
const editError    = ref('')
const editMaskDown = ref(false)

function showMsg(msg, isError = false) {
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
  } catch (e) {
    showMsg('加载失败：' + e.message, true)
  } finally {
    presetsLoading.value = false
  }
}

function openNewPreset() {
  editIsNew.value  = true
  editTarget.value = { name: '', provider: 'openai', api_key: '', base_url: PROVIDERS[0].base_url, model: PROVIDERS[0].model, max_tokens: 2000, temperature: 0.7, context_tokens: 3000, thinking: 'disabled', vision: false }
  editError.value  = ''
}

function openEditPreset(p) {
  editIsNew.value  = false
  editTarget.value = { ...p, api_key: '' }
  editError.value  = ''
}

function setEditProvider(key) {
  const pv = PROVIDERS.find(p => p.key === key)
  if (!pv) return
  editTarget.value.provider = key
  editTarget.value.base_url = pv.base_url
  editTarget.value.model    = pv.model
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
    editError.value = e.message
  } finally {
    editSaving.value = false
  }
}

async function activatePreset(id) {
  activatingId.value = id
  try {
    const res = await adminStore.authFetch(`/api/v1/admin/agent/llm-presets/${id}/activate`, { method: 'POST' })
    if (!res.ok) throw new Error(`切换失败（${res.status}）`)
    activePresetId.value = id
    showMsg('已切换，即时生效')
  } catch (e) {
    showMsg(e.message, true)
  } finally {
    activatingId.value = null
  }
}

async function deletePreset(id) {
  if (!confirm('确定删除该预设？')) return
  try {
    const res = await adminStore.authFetch(`/api/v1/admin/agent/llm-presets/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.detail || `删除失败（${res.status}）`)
    }
    await fetchPresets()
  } catch (e) {
    showMsg(e.message, true)
  }
}

async function testPreset(id) {
  testingId.value = id
  try {
    const res  = await adminStore.authFetch(`/api/v1/admin/agent/llm-presets/${id}/test`, { method: 'POST' })
    const data = await res.json()
    showMsg(data.ok ? `连通正常（${data.status}）` : `连接失败（${data.status}）：${data.detail}`, !data.ok)
  } catch (e) {
    showMsg('测试失败：' + e.message, true)
  } finally {
    testingId.value = null
  }
}

// 多模态探测：发一张极小图给该预设模型，按响应判定是否支持看图，结论自动写回 vision
async function probeVision(id) {
  probingId.value = id
  try {
    const res  = await adminStore.authFetch(`/api/v1/admin/agent/llm-presets/${id}/probe-vision`, { method: 'POST' })
    const data = await res.json()
    if (data.supported === true)       showMsg(`✅ 支持多模态（${data.status}），已开启`)
    else if (data.supported === false) showMsg(`该模型不支持多模态，已设为关闭：${data.detail}`, true)
    else                               showMsg(`测不准：${data.detail}`, true)
    await fetchPresets()   // 刷新「👁 多模态」徽章
  } catch (e) {
    showMsg('检测失败：' + e.message, true)
  } finally {
    probingId.value = null
  }
}

// ── 系统提示词 ────────────────────────────────────────────────────────────
const activeProfile  = ref('default')
const profiles       = ref([])
const placeholders   = ref([])
const promptContent  = ref('')
const promptSaving   = ref(false)
const promptSaved    = ref(false)
const promptError    = ref('')
const promptCache    = {}

async function fetchProfiles() {
  try {
    const res  = await adminStore.authFetch('/api/v1/admin/agent/prompts')
    const data = await res.json()
    profiles.value     = data.profiles
    placeholders.value = data.placeholders
    await loadPrompt('default')
  } catch (e) {
    promptError.value = '加载失败：' + e.message
  }
}

async function loadPrompt(profile) {
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
    promptError.value = '加载失败：' + e.message
  }
}

async function switchProfile(profile) {
  promptCache[activeProfile.value] = promptContent.value
  activeProfile.value = profile
  await loadPrompt(profile)
}

function insertPlaceholder(key) {
  const ta = document.querySelector('.prompt-textarea')
  if (!ta) return
  const start = ta.selectionStart
  const end   = ta.selectionEnd
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
    promptError.value = e.message
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
    behaviorError.value = e.message
    setTimeout(() => { behaviorError.value = '' }, 5000)
  } finally {
    behaviorSaving.value = false
  }
}

// ── 联网搜索（Tavily）────────────────────────────────────────────────────────
const searchDraft   = reactive({ ...configStore.cfg.search })
const searchSaving  = ref(false)
const searchSaved   = ref(false)
const searchError   = ref('')

function resetSearch() {
  Object.assign(searchDraft, configStore.cfg.search)
}

async function saveSearch() {
  searchSaving.value = true
  searchSaved.value  = false
  searchError.value  = ''
  try {
    await configStore.saveConfig({ search: { ...searchDraft } })
    searchSaved.value = true
    // key 保存后后端返回 ****，清空输入回到「不修改」态
    Object.assign(searchDraft, configStore.cfg.search)
    setTimeout(() => { searchSaved.value = false }, 3000)
  } catch (e) {
    searchError.value = e.message
    setTimeout(() => { searchError.value = '' }, 5000)
  } finally {
    searchSaving.value = false
  }
}

// ── 用量统计 ──────────────────────────────────────────────────────────────
const usage        = ref(null)
const usageLoading = ref(false)

const activeModel = ref(null)

async function fetchUsage(month = undefined, model = activeModel.value) {
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

function toggleModel(model) {
  activeModel.value = activeModel.value === model ? null : model
  fetchUsage(usage.value?.month, activeModel.value)
}

function fmtNum(n) {
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
const chartWrap    = ref(null)

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

async function switchMonth(dir) {
  if (!usage.value?.months) return
  const idx = monthIndex.value + dir
  if (idx < 0 || idx >= usage.value.months.length) return
  await fetchUsage(usage.value.months[idx], activeModel.value)
}

const chartPoints = computed(() => {
  if (!usage.value?.daily) return []
  const data = usage.value.daily
  const vals = data.map(d => d[activeMetric.value] ?? 0)
  const maxV = Math.max(...vals, 1)
  const n    = data.length
  const w    = CHART_W.value
  const xStep = (w - PAD_L - PAD_R) / Math.max(n - 1, 1)
  return vals.map((v, i) => ({
    x: PAD_L + i * xStep,
    y: PAD_T + (1 - v / maxV) * (CHART_H - PAD_T - PAD_B),
  }))
})

function smoothPath(pts) {
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
  const vals = usage.value.daily.map(d => d[activeMetric.value] ?? 0)
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
    .map((pt, i) => ({ x: pt.x, label: data[i]?.date?.slice(8) ?? '' }))
    .filter((_, i) => i % step === 0 || i === pts.length - 1)
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
.prompt-textarea::-webkit-scrollbar { width: 10px; height: 10px; }
.prompt-textarea::-webkit-scrollbar-track { background: transparent; }
.prompt-textarea::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 6px; }
.prompt-textarea::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.22); }
.prompt-textarea::-webkit-scrollbar-corner { background: transparent; }
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
.preset-card-meta { display: flex; gap: 12px; }
.preset-model { font-size: 12px; color: rgba(255,255,255,0.55); }
.preset-key   { font-size: 12px; color: rgba(255,255,255,0.28); font-family: 'SF Mono', monospace; }

.preset-card-actions { display: flex; gap: 6px; align-items: center; flex-shrink: 0; }
.pca-btn {
  padding: 5px 12px; border-radius: 8px; font-size: 12px; font-weight: 500;
  border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05);
  color: rgba(255,255,255,0.5); cursor: pointer; transition: all 0.15s;
}
.pca-btn:hover { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.75); }

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
  width: 480px; max-width: 92vw;
  background: rgba(22,22,34,0.97);
  backdrop-filter: blur(32px); -webkit-backdrop-filter: blur(32px);
  border: 1px solid rgba(255,255,255,0.1); border-radius: 18px;
  padding: 28px 28px 22px;
  box-shadow: 0 24px 80px rgba(0,0,0,0.5);
}
.modal-title { font-size: 16px; font-weight: 700; color: rgba(255,255,255,0.88); margin-bottom: 20px; }
.modal-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.modal-field label { font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.35); text-transform: uppercase; letter-spacing: 0.07em; }
.modal-input {
  width: 100%; padding: 9px 12px; border-radius: 9px;
  background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.1);
  font-size: 13px; color: rgba(255,255,255,0.82); outline: none;
  transition: border-color 0.15s; box-sizing: border-box;
}
.modal-input:focus { border-color: rgba(123,127,178,0.45); }
.modal-input::placeholder { color: rgba(255,255,255,0.2); }
.modal-actions {
  display: flex; align-items: center; gap: 10px;
  margin-top: 20px; padding-top: 16px;
  border-top: 1px solid rgba(255,255,255,0.07);
}
.modal-actions .save-hint { flex: 1; }
.modal-field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px; }
.modal-field-row .modal-field { margin-bottom: 0; }
.modal-field--row { flex-direction: row; align-items: center; justify-content: space-between; }
.modal-field--row > span { font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.35); letter-spacing: 0.07em; }
.thinking-label { display: flex; flex-direction: column; gap: 3px; }
.thinking-label > span:first-child { font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.35); text-transform: uppercase; letter-spacing: 0.07em; }
.thinking-hint { font-size: 11px; color: rgba(255,255,255,0.2); text-transform: none; letter-spacing: 0; font-weight: 400; }
.preset-meta-item { font-size: 12px; color: rgba(255,255,255,0.35); }
.preset-meta-think { color: rgba(149,144,196,0.85); background: rgba(149,144,196,0.1); padding: 1px 6px; border-radius: 4px; }
.preset-meta-vision { color: rgba(122,184,200,0.95); background: rgba(122,184,200,0.12); padding: 1px 6px; border-radius: 4px; }
.modal-input[type="number"] { -moz-appearance: textfield; }
.modal-input[type="number"]::-webkit-inner-spin-button,
.modal-input[type="number"]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
</style>
