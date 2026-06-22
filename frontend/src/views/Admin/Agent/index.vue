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

      <!-- ── LLM 配置 ── -->
      <section v-if="activeTab === 'llm'" class="config-card">
        <div class="card-head">
          <div class="card-icon" style="--ic:rgba(196,175,200,0.14);--stroke:#9590c4">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round">
              <circle cx="10" cy="10" r="7"/>
              <path d="M7 10h6M10 7v6"/>
            </svg>
          </div>
          <div class="card-title-block">
            <h3>LLM 配置</h3>
            <p>Agent 使用的模型与 API 密钥</p>
          </div>
        </div>

        <div class="toggle-group provider-grid">
          <button class="toggle-btn" :class="{ active: llmDraft.provider === 'openai' }"
            data-label="OpenAI 兼容" @click="setProvider('openai')">OpenAI 兼容</button>
          <button class="toggle-btn" :class="{ active: llmDraft.provider === 'anthropic' }"
            data-label="Anthropic" @click="setProvider('anthropic')">Anthropic</button>
          <button class="toggle-btn" :class="{ active: llmDraft.provider === 'qwen' }"
            data-label="通义千问" @click="setProvider('qwen')">通义千问</button>
          <button class="toggle-btn" :class="{ active: llmDraft.provider === 'deepseek' }"
            data-label="DeepSeek" @click="setProvider('deepseek')">DeepSeek</button>
          <button class="toggle-btn" :class="{ active: llmDraft.provider === 'minimax' }"
            data-label="MiniMax" @click="setProvider('minimax')">MiniMax</button>
        </div>

        <div class="field-grid">
          <ConfigField label="API Key"  v-model="llmDraft.api_key"  type="password" placeholder="留空表示不修改" class="span2" />
          <ConfigField label="Base URL" v-model="llmDraft.base_url" placeholder="https://…" class="span2" />
          <ConfigField label="模型名称" v-model="llmDraft.model"    placeholder="qwen-max" />
        </div>

        <div class="card-actions">
          <span class="save-hint" :class="{ error: !!llmError }">
            <template v-if="llmSaved"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 6l2.5 2.5 5.5-5"/></svg>已保存</template>
            <template v-else-if="llmError">{{ llmError }}</template>
          </span>
          <button class="btn-ghost" @click="resetLlm">撤销修改</button>
          <button class="btn-primary" :class="{ loading: llmSaving }" :disabled="llmSaving" @click="saveLlm">
            <svg v-if="llmSaving" class="spin-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 1v2M6 9v2M1 6h2M9 6h2"/></svg>
            {{ llmSaving ? '保存中…' : '保存' }}
          </button>
        </div>
      </section>

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
            >{{ p.profile }}</button>
          </div>
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
  if (key === 'prompts' && profiles.value.length === 0) fetchProfiles()
  if (key === 'usage' && !usage.value) fetchUsage()
}

// ── LLM 配置 ─────────────────────────────────────────────────────────────
const llmDraft  = reactive({ ...configStore.cfg.ai })
const llmSaving = ref(false)
const llmSaved  = ref(false)
const llmError  = ref('')

const AI_PRESETS = {
  qwen:      { base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-max' },
  openai:    { base_url: 'https://api.openai.com/v1',                         model: 'gpt-4o' },
  deepseek:  { base_url: 'https://api.deepseek.com',                          model: 'deepseek-chat' },
  minimax:   { base_url: 'https://api.minimaxi.com/anthropic',                model: 'MiniMax-M3' },
  anthropic: { base_url: 'https://api.anthropic.com/v1',                      model: 'claude-opus-4-8' },
}

function setProvider(p) {
  llmDraft.provider = p
  const preset = AI_PRESETS[p]
  if (preset) {
    llmDraft.base_url = preset.base_url
    llmDraft.model    = preset.model
  }
}

function resetLlm() {
  Object.assign(llmDraft, configStore.cfg.ai)
}

async function saveLlm() {
  llmSaving.value = true
  llmSaved.value  = false
  llmError.value  = ''
  try {
    await configStore.saveConfig({ ai: { ...llmDraft } })
    llmSaved.value = true
    setTimeout(() => { llmSaved.value = false }, 3000)
  } catch (e) {
    llmError.value = e.message
    setTimeout(() => { llmError.value = '' }, 5000)
  } finally {
    llmSaving.value = false
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
  Object.assign(llmDraft,   configStore.cfg.ai)
  Object.assign(agentDraft, configStore.cfg.agent)
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
  display: inline-flex; flex-direction: column; align-items: center;
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
</style>
