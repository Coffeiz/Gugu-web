<template>
      <Teleport to="body">
        <div
          v-if="draft"
          class="modal-mask"
          @mousedown.self="maskDown = true"
          @mouseup.self="maskDown && $emit('close'); maskDown = false"
        >
          <div class="modal-box">
            <h4 class="modal-title">{{ isNew ? '新建预设' : '编辑预设' }}</h4>

            <div class="modal-field">
              <label>预设名称</label>
              <input v-model="draft.name" placeholder="MiniMax 主力" class="modal-input" />
            </div>

            <div class="modal-field">
              <label>服务商</label>
              <div class="toggle-group" style="margin-bottom:0">
                <button v-for="pv in providers" :key="pv.key"
                  class="toggle-btn" :class="{ active: draft.provider === pv.key }"
                  :data-label="pv.label"
                  @click="$emit('set-provider', pv.key)">{{ pv.label }}</button>
              </div>
            </div>

            <div v-if="draft.provider === 'local'" class="modal-field">
              <label>本地运行时</label>
              <div class="toggle-group" style="margin-bottom:0">
                <button v-for="runtime in localRuntimes" :key="runtime.key" type="button" class="toggle-btn"
                  :class="{ active: (draft.local_runtime || 'other') === runtime.key }"
                  @click="draft.local_runtime = runtime.key">{{ runtime.label }}</button>
              </div>
              <div class="modal-hint">统一使用 OpenAI 兼容接口；工具、结构化输出等能力需检测或人工启用。</div>
            </div>

            <div v-if="draft.provider === 'ollama'" class="modal-field">
              <label>连接方式</label>
              <div class="toggle-group" style="margin-bottom:0">
                <button type="button" class="toggle-btn"
                  :class="{ active: (draft.ollama_mode || 'local') === 'local' }"
                  @click="$emit('set-ollama-mode', 'local')">本地 Ollama</button>
                <button type="button" class="toggle-btn"
                  :class="{ active: draft.ollama_mode === 'cloud' }"
                  @click="$emit('set-ollama-mode', 'cloud')">Ollama Cloud</button>
              </div>
              <div class="modal-hint">
                本地默认连接当前后端所在机器的 Ollama；云端需要填写 Ollama Cloud API Key。
              </div>
              <label style="margin-top:10px">接口模式</label>
              <div class="toggle-group" style="margin-bottom:0">
                <button type="button" class="toggle-btn"
                  :class="{ active: (draft.ollama_api_mode || 'native') === 'native' }"
                  @click="draft.ollama_api_mode = 'native'">Ollama 原生</button>
                <button type="button" class="toggle-btn"
                  :class="{ active: draft.ollama_api_mode === 'openai' }"
                  @click="draft.ollama_api_mode = 'openai'">OpenAI 兼容</button>
              </div>
              <div class="modal-hint">
                原生模式使用 <code>/api/chat</code>，支持原生思考、工具调用和模型驻留；兼容模式使用 <code>/v1</code>。
              </div>
              <div class="modal-hint ollama-mode-warning">
                原生模式只适用于已安装在 Ollama 中的模型（例如 <code>qwen3:8b</code>）。
                如果使用 <code>minimax-m3</code> 等外部模型或 OpenAI 兼容服务，请切换为「OpenAI 兼容」并填写对应的 <code>/v1</code> 地址。
              </div>
              <div v-if="(draft.ollama_api_mode || 'native') === 'native'" class="modal-field">
                <label>模型驻留</label>
                <input v-model="draft.ollama_keep_alive" class="modal-input" placeholder="5m" />
              </div>
            </div>

            <div class="modal-field">
              <label>{{ draft.provider === 'ollama' && (draft.ollama_mode || 'local') === 'local' ? 'API 密钥（可选）' : 'API 密钥' }}</label>
              <input v-model="draft.api_key" type="password" autocomplete="new-password"
                :placeholder="draft.provider === 'ollama' && (draft.ollama_mode || 'local') === 'local' ? '本地 Ollama 通常留空' : '留空表示不修改'" class="modal-input" />
            </div>

            <div class="modal-field">
              <label>接口地址</label>
              <input v-model="draft.base_url" :placeholder="draft.provider === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'https://…'" class="modal-input" />
              <div v-if="draft.provider === 'ollama'" class="modal-hint">
                本地：<code>http://127.0.0.1:11434/v1</code>；云端：<code>https://ollama.com/v1</code>。地址指向运行 Gugu 后端的机器。
              </div>
              <div v-if="draft.provider === 'qwen'" class="modal-hint">
                百炼建议使用业务空间专属域名：<code>https://&#123;WorkspaceId&#125;.cn-beijing.maas.aliyuncs.com/compatible-mode/v1</code>（WorkspaceId 在控制台业务空间详情页查看）；通用域名 dashscope.aliyuncs.com 仍可用
              </div>
              <div v-if="draft.provider === 'glm'" class="modal-field glm-mode-field">
                <label>GLM 接口类型</label>
                <div class="toggle-group" style="margin-bottom:0">
                  <button type="button" class="toggle-btn"
                    :class="{ active: !(draft.base_url || '').includes('/api/coding/') }"
                    @click="draft.base_url = 'https://open.bigmodel.cn/api/paas/v4'">通用 API</button>
                  <button type="button" class="toggle-btn"
                    :class="{ active: (draft.base_url || '').includes('/api/coding/') }"
                    @click="draft.base_url = 'https://open.bigmodel.cn/api/coding/paas/v4'">Coding Plan</button>
                </div>
                <div class="modal-hint">
                  通用 API 与 Coding Plan 使用不同额度和 API Key；Coding Plan 按官方要求使用专属端点。模型示例：<code>glm-5.2</code>、<code>glm-4.7</code>
                </div>
              </div>
            </div>

            <div class="modal-field">
              <label>模型名称</label>
              <div class="model-picker" @focusout="$emit('close-model-menu')">
                <div class="model-picker-row">
                  <input v-model="draft.model" placeholder="qwen-max" class="modal-input"
                    @focus="$emit('open-model-menu')" />
                  <button type="button" class="model-fetch-btn" :disabled="modelLoading"
                    title="从服务商获取模型列表"
                    @mousedown.prevent @click="$emit('fetch-model-list')">
                    {{ modelLoading ? '获取中…' : '获取列表' }}
                  </button>
                </div>
                <div v-if="modelMenuOpen" class="model-options" @mousedown.stop>
                  <div v-if="modelError" class="model-option-hint error">{{ modelError }}</div>
                  <div v-else-if="!modelOptions.length" class="model-option-hint">
                    点击“获取列表”加载可用模型
                  </div>
                  <button v-for="model in filteredModels" :key="model" type="button" class="model-option"
                    @mousedown.prevent="$emit('select-model', model)">{{ model }}</button>
                </div>
              </div>
            </div>

            <div class="modal-field" v-if="draft.provider === 'mimo'">
              <label>接口格式 <span class="thinking-hint" style="font-weight:400">Anthropic 格式支持思考块、缓存和读取库内图片</span></label>
              <div class="api-format-grid">
                <button v-for="f in apiFormats" :key="f.key" type="button"
                  class="toggle-btn" :class="{ active: (draft.api_format || 'openai') === f.key }"
                  @click="$emit('pick-api-format', f.key)">{{ f.label }}</button>
              </div>
            </div>

            <div class="modal-field-row">
              <div class="modal-field">
                <label>最大输出令牌数</label>
                <input v-model.number="draft.max_tokens" type="number" min="100" max="32000" step="100" class="modal-input" />
              </div>
              <div class="modal-field">
                <label>温度</label>
                <input v-model.number="draft.temperature" type="number" min="0" max="2" step="0.05" class="modal-input" />
              </div>
            </div>

            <div class="modal-field">
              <label>上下文历史令牌数</label>
              <input v-model.number="draft.context_tokens" type="number" min="500" max="200000" step="500" class="modal-input" />
            </div>

            <div class="modal-field modal-field--row">
              <div class="thinking-label">
                <span>深度思考</span>
                <span class="thinking-hint">MiniMax M3、Anthropic、MiMo、DeepSeek、GLM（自适应模式）</span>
              </div>
              <ToggleSwitch :model-value="draft.thinking === 'adaptive'" aria-label="切换深度思考" @update:model-value="draft.thinking = $event ? 'adaptive' : 'disabled'" />
            </div>

            <div class="modal-field modal-field--row" v-if="draft.provider === 'deepseek'">
              <div class="thinking-label">
                <span>思考强度</span>
                <span class="thinking-hint">思考开启时生效；关闭思考时先保存选择</span>
              </div>
              <div class="option-button-row">
                <button v-for="effort in deepseekEfforts" :key="effort.key" type="button" class="toggle-btn"
                  :class="{ active: draft.reasoning_effort === effort.key || (!draft.reasoning_effort && effort.key === '') }"
                  @click="draft.reasoning_effort = effort.key">{{ effort.label }}</button>
              </div>
            </div>

            <div class="modal-field modal-field--row" v-if="draft.provider === 'deepseek'">
              <div class="thinking-label">
                <span>图片细节级别</span>
                <span class="thinking-hint">DeepSeek Vision 的图片细节级别；自动选择通常等价于原图</span>
              </div>
              <div class="option-button-row">
                <button v-for="detail in imageDetailLevels" :key="detail.key" type="button" class="toggle-btn"
                  :class="{ active: (draft.vision_detail || 'auto') === detail.key }"
                  @click="draft.vision_detail = detail.key">{{ detail.label }}</button>
              </div>
            </div>

            <div class="modal-field modal-field--row">
              <div class="thinking-label">
                <span>多模态能力</span>
                <span class="thinking-hint">图片/视频/音频分别开关；点「检测」自动判定该维度是否支持，成功后自动开启</span>
              </div>
            </div>

            <div v-if="draft.provider === 'local'" class="modal-field">
              <div class="thinking-label">
                <span>本地能力覆盖</span>
                <span class="thinking-hint">仅覆盖已确认的能力；留空表示使用默认声明</span>
              </div>
              <LocalCapabilityOverrides
                :model="draft"
                :disabled="isNew"
                :loading="capabilityLoading"
                :checked-at="draft.capability_checked_at"
                :results="capabilityResults"
                @toggle="forwardCapabilityOverride"
                @probe="$emit('probe-capabilities', String(draft.id || ''))"
              />
            </div>

            <div class="modal-field modal-field--row" v-for="dim in visionDims" :key="dim.key">
              <div class="thinking-label">
                <span>{{ dim.label }}</span>
                <span class="thinking-hint">{{ dim.hint }}</span>
              </div>
              <div class="option-button-row option-button-row--center">
                <button
                  type="button"
                  class="pca-btn pca-btn--sm"
                  :class="{ 'pca-btn--testing': probingDim === dim.key }"
                  :disabled="probingDim !== null && probingDim !== dim.key"
                  :title="isNew ? '检测草稿，不会写入配置；保存后生效' : ''"
                  @click="$emit('probe-vision', draft.id, dim.key)"
                >{{ probingDim === dim.key ? '检测中…' : '检测' }}</button>
                <ToggleSwitch :model-value="Boolean(draft[dim.key === 'image' ? 'vision' : 'vision_' + dim.key])" :aria-label="`切换${dim.label}`" @update:model-value="draft[dim.key === 'image' ? 'vision' : 'vision_' + dim.key] = $event" />
              </div>
            </div>

            <div class="modal-actions">
              <span class="save-hint" :class="{ error: !!error }">{{ error }}</span>
              <button class="btn-ghost" @click="$emit('close')">取消</button>
              <button class="btn-primary" :disabled="saving" @click="$emit('save')">
                <svg v-if="saving" class="spin-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 1v2M6 9v2M1 6h2M9 6h2"/></svg>
                {{ saving ? '保存中…' : '保存' }}
              </button>
            </div>
          </div>
        </div>
      </Teleport>
</template>
<script setup lang="ts">
import { ref } from 'vue'
import LocalCapabilityOverrides from '../../components/LocalCapabilityOverrides.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'

interface Provider { key: string; label: string; base_url: string; model: string }
interface Option { key: string; label: string; hint?: string }
interface LlmPresetDraft {
  id?: string | number; name: string; provider: string; api_key: string; base_url: string; model: string
  max_tokens: number; temperature: number; context_tokens: number; thinking: string
  vision: boolean; vision_video: boolean; vision_audio: boolean
  capability_checked_at?: string
  [key: string]: unknown
}
defineProps<{
  draft: LlmPresetDraft | null; isNew: boolean; saving: boolean; error: string
  providers: Provider[]; localRuntimes: Option[]; apiFormats: Option[]; deepseekEfforts: Option[]; imageDetailLevels: Option[]; visionDims: Option[]
  capabilityLoading: boolean; capabilityResults: Record<string, { status?: string; detail?: string }>; modelLoading: boolean; modelError: string
  modelMenuOpen: boolean; modelOptions: string[]; filteredModels: string[]; probingDim: string | null
}>()
const $emit = defineEmits<{
  (event: 'close'): void; (event: 'save'): void; (event: 'set-provider', key: string): void; (event: 'set-ollama-mode', mode: 'local' | 'cloud'): void; (event: 'open-model-menu'): void
  (event: 'close-model-menu'): void; (event: 'fetch-model-list'): void; (event: 'select-model', model: string): void; (event: 'pick-api-format', format: string): void
  (event: 'set-capability-override', key: string, enabled: boolean): void; (event: 'probe-capabilities', id: string): void; (event: 'probe-vision', id: string | number | undefined, dim: string): void
}>()
const maskDown = ref(false)
function forwardCapabilityOverride(key: string, enabled: boolean) {
  $emit('set-capability-override', key, enabled)
}
</script>

<style scoped>
/* 弹窗样式沿用 Agent Admin 控件规范，弹窗自身不再由页面入口承载。 */
.modal-mask { position:fixed; inset:0; z-index:1000; display:flex; align-items:center; justify-content:center; padding:20px; background:rgba(4,5,12,.58); backdrop-filter:blur(8px); }
.modal-box { width:min(620px,100%); max-height:calc(100vh - 40px); overflow:auto; padding:22px 24px; border:1px solid rgba(255,255,255,.1); border-radius:16px; background:rgba(20,22,38,.96); box-shadow:0 8px 36px rgba(0,0,0,.42), inset 0 1px rgba(255,255,255,.06); color:rgba(255,255,255,.82); }
.modal-title { margin:0 0 14px; color:rgba(255,255,255,.88); font-size:16px; font-weight:700; }
.modal-field { display:flex; flex-direction:column; gap:6px; margin-bottom:10px; }.modal-field label { color:rgba(255,255,255,.4); font-size:11px; font-weight:600; }.modal-input { width:100%; box-sizing:border-box; padding:7px 10px; border:1px solid rgba(255,255,255,.1); border-radius:9px; background:rgba(255,255,255,.06); color:rgba(255,255,255,.78); font-size:13px; outline:none; }.modal-input:focus { border-color:rgba(123,127,178,.45); }.modal-hint,.thinking-hint { color:rgba(255,255,255,.38); font-size:11px; line-height:1.5; }.toggle-group,.api-format-grid { display:flex; flex-wrap:wrap; gap:6px; }.toggle-btn { padding:6px 12px; border:1px solid rgba(255,255,255,.1); border-radius:9px; background:rgba(255,255,255,.05); color:rgba(255,255,255,.48); font-size:12px; cursor:pointer; }.toggle-btn.active { border-color:rgba(123,127,178,.35); background:rgba(123,127,178,.2); color:rgba(255,255,255,.88); }.modal-field-row { display:grid; grid-template-columns:1fr 1fr; gap:12px; }.modal-field--row { flex-direction:row; align-items:center; justify-content:space-between; }.thinking-label { display:flex; flex-direction:column; gap:3px; }.model-picker { position:relative; }.model-picker-row { display:flex; gap:6px; }.model-picker-row .modal-input { flex:1; }.model-fetch-btn,.pca-btn { padding:6px 10px; border:1px solid rgba(255,255,255,.1); border-radius:8px; background:rgba(255,255,255,.06); color:rgba(255,255,255,.58); font-size:12px; cursor:pointer; }.model-fetch-btn:disabled,.pca-btn:disabled { opacity:.5; cursor:default; }.model-options { position:absolute; z-index:2; top:calc(100% + 4px); left:0; right:0; max-height:180px; overflow:auto; padding:4px; border:1px solid rgba(255,255,255,.11); border-radius:10px; background:rgba(20,22,38,.98); }.model-option { display:block; width:100%; padding:7px 9px; border:0; border-radius:6px; background:transparent; color:rgba(255,255,255,.7); text-align:left; cursor:pointer; }.model-option:hover { background:rgba(255,255,255,.07); }.model-option-hint { padding:7px 9px; color:rgba(255,255,255,.35); font-size:11px; }.model-option-hint.error { color:#e07878; }.modal-actions { display:flex; align-items:center; gap:10px; margin-top:18px; padding-top:16px; border-top:1px solid rgba(255,255,255,.07); }.save-hint { flex:1; color:#5ab899; font-size:12px; }.save-hint.error { color:#e07878; }.btn-ghost,.btn-primary { padding:6px 14px; border-radius:9px; font-size:13px; cursor:pointer; }.btn-ghost { border:1px solid rgba(255,255,255,.1); background:rgba(255,255,255,.06); color:rgba(255,255,255,.55); }.btn-primary { border:0; background:linear-gradient(135deg,#7b7fb2,#9590c4); color:#fff; font-weight:600; }.btn-primary:disabled,.btn-ghost:disabled { opacity:.5; cursor:default; }.ollama-mode-warning { color:rgba(242,190,126,.78); }
.modal-input::placeholder { color: rgba(255,255,255,.2); }
.modal-field label { color: rgba(255,255,255,.35); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .07em; }
.modal-hint code { color: rgba(123,127,178,.9); background: rgba(123,127,178,.12); padding: 1px 5px; border-radius: 4px; font-size: 10.5px; word-break: break-all; }
.modal-field-row { margin-bottom: 10px; }
.modal-field-row .modal-field { margin-bottom: 0; }
.modal-field--row > span { font-size: 11px; font-weight: 600; color: rgba(255,255,255,.35); letter-spacing: .07em; }
.thinking-label > span:first-child { font-size: 11px; font-weight: 600; color: rgba(255,255,255,.35); text-transform: uppercase; letter-spacing: .07em; }
.thinking-hint { color: rgba(255,255,255,.2); text-transform: none; letter-spacing: 0; font-weight: 400; }
.option-button-row { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.option-button-row--center { justify-content:flex-end; }
.toggle-btn { display:inline-flex; align-items:center; justify-content:center; min-height:var(--control-md); box-sizing:border-box; line-height:1.2; }
.model-fetch-btn, .pca-btn { display:inline-flex; align-items:center; justify-content:center; min-height:var(--control-md); box-sizing:border-box; line-height:1.2; }
.btn-ghost, .btn-primary { display:inline-flex; align-items:center; justify-content:center; min-height:var(--control-md); box-sizing:border-box; line-height:1.2; }
@media(max-width:720px){ .modal-field-row { grid-template-columns:1fr; gap:0; } .modal-box { padding:18px; } }
</style>
<style scoped>
.btn-primary { background: var(--action-primary-bg); color: var(--content-on-accent); transition: background-color .15s; }
.btn-primary:hover:not(:disabled) { background: var(--action-primary-bg-hover); }
</style>
