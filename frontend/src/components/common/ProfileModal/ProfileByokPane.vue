<template>
  <div>
    <div class="pm-section">
      <div class="pm-section-label">模型配置</div>
      <p class="pm-field-hint">凭据只在服务端加密保存，不会回显到页面、对话或日志。每类模型可单独启用；全部停用时使用 Admin 默认配置。</p>
      <div v-if="needsReconfigure" class="pm-msg err">BYOK 主密钥校验失败，请重新输入并保存各 Provider API Key。</div>
      <div v-if="loading" class="pm-field-hint">加载中…</div>
      <div v-else-if="error" class="pm-msg err">{{ error }}</div>
      <template v-else>
        <div v-for="group in groups" :key="group.value" class="byok-group">
          <div class="byok-group-heading"><div class="byok-group-title">{{ group.label }}</div><button class="pm-style-chip" @click="openEditor(group.value)">＋ 添加模型</button></div>
          <div v-if="itemsFor(group.value).length === 0" class="pm-field-hint">尚未配置</div>
          <div v-if="itemsFor(group.value).length" class="byok-card-grid">
            <template v-for="item in itemsFor(group.value)" :key="item.id">
            <div class="byok-card">
              <div class="byok-card-head">
                <div class="byok-card-main">
                  <div class="byok-name">{{ item.provider }}<span v-if="item.model"> · {{ item.model }}</span><template v-if="item.capability === 'llm'"><span v-for="dim in visionDims.filter(entry => item[entry.field])" :key="dim.key" class="byok-capability-tag">{{ dim.label }}</span></template></div>
                  <div class="byok-meta">{{ item.api_format || '自动协议' }} · {{ item.has_value ? '已加密保存' : '无凭据' }}</div>
                </div>
              </div>
              <div class="byok-card-actions">
                <button class="pm-style-chip" :class="{ active: item.enabled }" @click="toggle(item)">{{ item.enabled ? '已启用' : '已停用' }}</button>
                <button v-if="item.capability === 'llm'" class="pm-style-chip" :disabled="visionTesting?.startsWith(`${item.id}:`)" @click="probeCardVisionAll(item)">{{ visionTesting === `${item.id}:all` ? '检测中…' : '检测多模态' }}</button>
                <button class="pm-style-chip" :disabled="testing === item.id" @click="test(item)">{{ testing === item.id ? '测试中…' : '测试' }}</button>
                <button class="pm-style-chip" @click="openEditor(item.capability, item)">编辑</button>
                <button class="pm-danger-btn" @click="remove(item)">删除</button>
              </div>
            </div>
            <Transition :name="editors[item.id] || closingEditors.has(item.id) ? 'byok-editor' : 'byok-editor-none'" @after-leave="clearClosingEditor(item.id)">
            <div v-if="editors[item.id]" :key="item.id" class="byok-editor byok-editor--expanded" @click="setActiveEditor(item.id)">
            <div class="byok-editor-title">编辑模型配置</div>
            <div class="byok-form-grid">
              <AdminSelect v-model="editors[item.id].provider" :options="providersFor(editors[item.id].capability)" placeholder="选择 Provider" @update:model-value="applyProvider" />
              <input v-model="editors[item.id].value" class="form-input" type="password" autocomplete="new-password" placeholder="API Key（留空保持不变）" />
              <div v-if="editors[item.id].provider === 'mimo'" class="api-format-field"><span class="field-label">接口格式</span><div class="api-format-grid"><button type="button" class="pm-style-chip" :class="{ active: (editors[item.id].api_format || 'openai') === 'openai' }" @click="editors[item.id].api_format = 'openai'"><span>OpenAI 兼容</span></button><button type="button" class="pm-style-chip" :class="{ active: editors[item.id].api_format === 'anthropic' }" @click="editors[item.id].api_format = 'anthropic'">Anthropic</button></div></div>
              <input v-model="editors[item.id].base_url" class="form-input" placeholder="Base URL（可选）" />
              <div class="model-picker" :ref="el => setModelPickerRef(item.id, el)"><div class="model-picker-row"><input v-model="editors[item.id].model" class="form-input" :placeholder="group.value === 'speech_to_text' ? '语音模型名（可选）' : '模型名（可选）'" /><button type="button" class="pm-style-chip" :disabled="modelLoading" @click="fetchModels">{{ modelLoading ? '获取中…' : '获取列表' }}</button></div><PopupMenu :show="modelMenuOpen && editor?.id === item.id" :anchor="modelPickerRefs[item.id]" popup-class="model-options"><div v-if="modelError" class="model-option-hint err">{{ modelError }}</div><div v-else-if="!modelOptions.length" class="model-option-hint">暂无可用模型</div><button v-for="model in modelOptions" :key="model" type="button" class="model-option" @click="selectModel(model)">{{ model }}</button></PopupMenu></div>
              <MultimodalCapabilities v-if="editors[item.id].capability === 'llm'" :model="editors[item.id]" :dims="visionDims" title="多模态能力" :probing="visionTesting" @probe="probeVision" />
            </div>
            <div class="byok-editor-actions"><button class="pm-style-chip" :disabled="testing === item.id" @click="test({ id: item.id, capability: editors[item.id].capability })">{{ testing === item.id ? '测试中…' : '测试' }}</button><button class="pm-style-chip" @click="closeEditor(item.id)">取消</button><button class="pm-style-chip active" :disabled="saving || !editors[item.id].provider" @click="saveEditor(item.id)">{{ saving ? '保存中…' : '保存配置' }}</button></div>
            </div>
            </Transition>
            </template>
          </div>
          <div v-if="newEditor && newEditor.capability === group.value" class="byok-editor byok-editor--new">
            <div class="byok-editor-title">添加{{ group.label }}配置</div>
            <div class="byok-form-grid">
              <AdminSelect v-model="newEditor.provider" :options="providersFor(newEditor.capability)" placeholder="选择 Provider" @update:model-value="applyProviderTo(newEditor)" />
              <input v-model="newEditor.value" class="form-input" type="password" autocomplete="new-password" placeholder="API Key" />
              <input v-model="newEditor.base_url" class="form-input" placeholder="Base URL（可选）" />
              <input v-model="newEditor.model" class="form-input" placeholder="模型名（可选）" />
              <MultimodalCapabilities v-if="newEditor.capability === 'llm'" :model="newEditor" :dims="visionDims" title="多模态能力" :probing="visionTesting" @probe="probeNewVision" />
            </div>
            <div class="byok-editor-actions"><button class="pm-style-chip" @click="closeNewEditor">取消</button><button class="pm-style-chip active" :disabled="saving || !newEditor.provider || !newEditor.value" @click="saveNewEditor">{{ saving ? '保存中…' : '保存配置' }}</button></div>
          </div>
          <div v-if="message && messageCapability === group.value" class="byok-message pm-msg" :class="messageType">{{ message }}</div>
        </div>
      </template>
    </div>
    <div class="pm-sep"></div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { byokApi } from '@/services/api'
import AdminSelect from '@/components/AdminSelect.vue'
import MultimodalCapabilities from '@/components/common/MultimodalCapabilities.vue'
import PopupMenu from '@/components/common/PopupMenu.vue'

type Item = { id: number; capability: string; provider: string; api_format: string; base_url: string; model: string; vision: boolean; vision_video: boolean; vision_audio: boolean; vision_detail: string; has_value: boolean; enabled: boolean; [key: string]: any }
type Editor = { id?: number; capability: string; provider: string; value: string; api_format: string; base_url: string; model: string; vision: boolean; vision_video: boolean; vision_audio: boolean; vision_detail: string }
type ProviderOption = { value: string; label: string; base_url: string; model: string }
const modelProviders: ProviderOption[] = [
  { value: 'openai', label: 'OpenAI 兼容', base_url: 'https://api.openai.com/v1', model: 'gpt-4o' }, { value: 'anthropic', label: 'Anthropic', base_url: 'https://api.anthropic.com/v1', model: 'claude-opus-4-8' },
  { value: 'qwen', label: 'DashScope（百炼）', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-max' }, { value: 'glm', label: '智谱 GLM', base_url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.2' },
  { value: 'deepseek', label: 'DeepSeek', base_url: 'https://api.deepseek.com', model: 'deepseek-v4-flash-vision-exp' }, { value: 'minimax', label: 'MiniMax', base_url: 'https://api.minimaxi.com/anthropic', model: 'MiniMax-M3' },
  { value: 'mimo', label: 'MiMo（小米）', base_url: 'https://api.xiaomimimo.com/v1', model: 'mimo-mono.5' }, { value: 'ollama', label: 'Ollama', base_url: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' },
  { value: 'local', label: '本地兼容服务', base_url: '', model: '' },
]
const groups = [
  { value: 'llm', label: '通用模型' }, { value: 'speech_to_text', label: '语音模型' },
]
const visionDims = [{ key: 'image', label: '图片', field: 'vision' }, { key: 'video', label: '视频', field: 'vision_video' }, { key: 'audio', label: '音频', field: 'vision_audio' }] as const
const items = ref<Item[]>([]); const loading = ref(false); const saving = ref(false); const testing = ref<number | null>(null); const visionTesting = ref<string | null>(null); const needsReconfigure = ref(false); const error = ref(''); const message = ref(''); const messageCapability = ref(''); const messageType = ref('ok'); const editor = ref<Editor | null>(null); const editors = ref<Record<number, Editor>>({}); const closingEditors = ref(new Set<number>()); const newEditor = ref<Editor | null>(null); const lastEditorWasExisting = ref(false); const modelLoading = ref(false); const modelError = ref(''); const modelOptions = ref<string[]>([]); const modelMenuOpen = ref(false); const modelPickerRefs = ref<Record<number, HTMLElement | null>>({})
function setModelPickerRef(id: number, element: Element | null | unknown) { modelPickerRefs.value[id] = element instanceof HTMLElement ? element : null }
function itemsFor(capability: string) { return items.value.filter(item => item.capability === capability) }
function providersFor(capability: string): ProviderOption[] {
  return capability === 'speech_to_text' ? modelProviders.filter(item => ['openai', 'qwen', 'local'].includes(item.value)) : modelProviders
}
function applyProvider() {
  if (!editor.value) return
  const provider = modelProviders.find(item => item.value === editor.value?.provider)
  if (!provider) return
  editor.value.base_url = provider.base_url
  editor.value.model = provider.model
  editor.value.api_format = editor.value.provider === 'mimo' ? 'openai' : ''
}
async function fetchModels() {
  if (!editor.value || !editor.value.provider) return
  modelLoading.value = true; modelError.value = ''; modelMenuOpen.value = true
  try {
    const result = await byokApi.modelsPreview({ provider: editor.value.provider, base_url: editor.value.base_url, api_format: editor.value.api_format, api_key: editor.value.value, credential_id: editor.value.id })
    modelOptions.value = result.models || []
    if (!modelOptions.value.length) modelError.value = 'Provider 没有返回可用模型'
  } catch (e) { modelOptions.value = []; modelError.value = e instanceof Error ? e.message : '获取模型列表失败' }
  finally { modelLoading.value = false }
}
function selectModel(model: string) { if (editor.value) editor.value.model = model; modelMenuOpen.value = false }
async function probeVision(dim: typeof visionDims[number]['key']) { if (!editor.value || !editor.value.provider || !editor.value.model) return; visionTesting.value = dim; try { const result = await byokApi.visionProbe({ provider: editor.value.provider, api_format: editor.value.api_format, base_url: editor.value.base_url, api_key: editor.value.value, credential_id: editor.value.id, model: editor.value.model, dim }); if (result.supported !== null) { const field = visionDims.find(item => item.key === dim)?.field; if (field && editor.value) { editor.value[field] = result.supported; const saved = items.value.find(item => item.id === editor.value?.id); if (saved) saved[field] = result.supported } } message.value = result.detail || (result.supported ? `${dim}能力支持` : `${dim}能力不支持`); messageType.value = result.supported === false ? 'err' : 'ok' } catch (e) { message.value = e instanceof Error ? e.message : '多模态检测失败'; messageType.value = 'err' } finally { visionTesting.value = null } }
async function probeCardVisionAll(item: Item) {
  if (!item.provider || !item.model) return
  visionTesting.value = `${item.id}:all`
  messageCapability.value = item.capability
  const labels = { image: '图片', video: '视频', audio: '音频' } as const
  const results: string[] = []
  const detected: Record<string, boolean> = {}
  try {
    for (const dim of visionDims) {
      const result = await byokApi.visionProbe({ provider: item.provider, api_format: item.api_format, base_url: item.base_url, api_key: '', credential_id: item.id, model: item.model, dim: dim.key })
      const field = dim.field
      if (result.supported !== null) { item[field] = result.supported; detected[field] = result.supported }
      results.push(`${labels[dim.key]}：${result.supported === true ? '支持' : result.supported === false ? '不支持' : '测不准'}`)
    }
    if (Object.keys(detected).length) Object.assign(item, await byokApi.update(item.id, detected))
    message.value = `多模态检测完成（${results.join('；')}）`
    messageType.value = 'ok'
  } catch (e) { message.value = e instanceof Error ? e.message : '多模态检测失败'; messageType.value = 'err' }
  finally { visionTesting.value = null }
}
async function load() { loading.value = true; error.value = ''; try { const result = await byokApi.list(); items.value = result.items as Item[]; needsReconfigure.value = result.status === 'needs_reconfigure' } catch (e) { error.value = e instanceof Error ? e.message : 'BYOK 加载失败' } finally { loading.value = false } }
function setActiveEditor(id: number) { editor.value = editors.value[id] || null }
function openEditor(capability: string, item?: Item) { if (item) { if (editors.value[item.id]) { closeEditor(item.id); return } lastEditorWasExisting.value = true; const draft = { id: item.id, capability, provider: item.provider, value: '', api_format: item.api_format || '', base_url: item.base_url || '', model: item.model || '', vision: Boolean(item.vision), vision_video: Boolean(item.vision_video), vision_audio: Boolean(item.vision_audio), vision_detail: item.vision_detail || 'auto' }; editors.value[item.id] = draft; editor.value = draft } else { newEditor.value = { capability, provider: '', value: '', api_format: '', base_url: '', model: '', vision: false, vision_video: false, vision_audio: false, vision_detail: 'auto' } } modelOptions.value = []; modelError.value = ''; modelMenuOpen.value = false; message.value = '' }
function applyProviderTo(target: Editor) { const provider = modelProviders.find(item => item.value === target.provider); if (provider) { target.base_url = provider.base_url; target.model = provider.model; target.api_format = target.provider === 'mimo' ? 'openai' : '' } }
function closeNewEditor() { newEditor.value = null }
async function saveNewEditor() { if (!newEditor.value) return; saving.value = true; try { const draft = newEditor.value; const row = await byokApi.create({ provider: draft.provider, capability: draft.capability, value: draft.value, api_format: draft.api_format, base_url: draft.base_url, model: draft.model, vision: draft.vision, vision_video: draft.vision_video, vision_audio: draft.vision_audio, vision_detail: draft.vision_detail }); items.value.push(row as Item); newEditor.value = null } catch (e) { message.value = e instanceof Error ? e.message : '保存失败'; messageType.value = 'err' } finally { saving.value = false } }
function probeNewVision(dim: string) { if (!newEditor.value) return; const previous = editor.value; editor.value = newEditor.value; void probeVision(dim as typeof visionDims[number]['key']).finally(() => { if (newEditor.value) newEditor.value = editor.value; editor.value = previous }) }
function clearClosingEditor(id: number) { closingEditors.value.delete(id) }
function closeEditor(id?: number) { if (id !== undefined) { closingEditors.value.add(id); delete editors.value[id] }; editor.value = id !== undefined && editor.value?.id === id ? null : editor.value; modelMenuOpen.value = false }
async function saveEditor(id: number) { const draft = editors.value[id]; if (!draft) return; saving.value = true; message.value = ''; try { const payload: Record<string, unknown> = { provider: draft.provider, capability: draft.capability, api_format: draft.api_format, base_url: draft.base_url, model: draft.model, vision: draft.vision, vision_video: draft.vision_video, vision_audio: draft.vision_audio, vision_detail: draft.vision_detail }; if (draft.value) payload.value = draft.value; const row = await byokApi.update(id, payload); const index = items.value.findIndex(item => item.id === row.id); if (index >= 0) items.value[index] = row as Item; delete editors.value[id]; if (editor.value?.id === id) editor.value = null; message.value = '模型配置已保存'; messageType.value = 'ok' } catch (e) { message.value = e instanceof Error ? e.message : '保存失败'; messageType.value = 'err' } finally { saving.value = false } }
async function toggle(item: Item) { try { const enabled = !item.enabled; Object.assign(item, await byokApi.update(item.id, { enabled })); if (enabled) items.value.filter(row => row.capability === item.capability && row.id !== item.id).forEach(row => { row.enabled = false }) } catch (e) { message.value = e instanceof Error ? e.message : '更新失败'; messageType.value = 'err' } }
async function test(item: { id: number; capability: string }) { testing.value = item.id; messageCapability.value = item.capability; try { const body = await byokApi.test(item.id); message.value = body.message || (body.ok ? '检查通过' : '检查失败'); messageType.value = body.ok ? 'ok' : 'err' } catch (e) { message.value = e instanceof Error ? e.message : '检查失败'; messageType.value = 'err' } finally { testing.value = null } }
async function remove(item: Item) { if (!window.confirm(`确定删除 ${item.provider} 凭据？`)) return; try { await byokApi.remove(item.id); items.value = items.value.filter(row => row.id !== item.id) } catch (e) { message.value = e instanceof Error ? e.message : '删除失败'; messageType.value = 'err' } }
function closeModelMenuOnOutside(event: MouseEvent) {
  const target = event.target
  if (modelMenuOpen.value && (!(target instanceof Element) || !target.closest('.model-picker'))) modelMenuOpen.value = false
}
onMounted(() => { load(); document.addEventListener('mousedown', closeModelMenuOnOutside) })
onBeforeUnmount(() => document.removeEventListener('mousedown', closeModelMenuOnOutside))
</script>

<style scoped>
.byok-group { margin-top: 14px; }
.byok-group-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.byok-group-title { color: var(--text-primary); font-size: 13px; font-weight: 650; margin-bottom: 6px; }
.byok-card-grid { display: grid; grid-template-columns: 1fr; row-gap: 10px; margin-top: 8px; }
.byok-card { display: flex; align-items: center; gap: 12px; min-width: 0; padding: 11px 12px; border: 1px solid var(--input-border, var(--divider-line)); border-radius: 12px; background: var(--surface-subtle); box-shadow: inset 0 1px rgba(255,255,255,.18); }
.byok-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.byok-card-head { flex: 1; min-width: 0; }
.byok-card-main { min-width: 0; }
.byok-name { min-width: 0; color: var(--text-primary); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.byok-capability-tag { display: inline-flex; margin-left: 5px; padding: 2px 6px; border: 1px solid color-mix(in srgb, var(--accent-color, #7b7fb2) 35%, transparent); border-radius: var(--choice-chip-radius); color: var(--text-secondary); font-size: 10px; vertical-align: 1px; }
.byok-meta { color: var(--text-secondary); font-size: 11px; margin-top: 3px; }
.byok-expired { color: var(--color-danger, #c66); }
.byok-card-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; flex-shrink: 0; }
.byok-card-actions .pm-danger-btn { padding: 5px 10px; border-radius: var(--choice-chip-radius); }
.byok-message { margin-top: 12px; }
.byok-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 10px 0; }
.byok-editor { margin-top: 8px; padding: 12px; border: 1px solid var(--input-border); border-radius: 10px; background: var(--surface-subtle); }
.byok-editor--expanded { margin-top: 0; border-top: 1px solid var(--input-border); border-left: 0; border-right: 0; border-top-left-radius: 0; border-top-right-radius: 0; box-shadow: inset 1px 0 var(--input-border), inset -1px 0 var(--input-border); }
.byok-card-grid, .byok-editor { overflow-anchor: none; }
.byok-card-grid:has(.byok-editor--expanded) { row-gap: 10px; }
.byok-card:has(+ .byok-editor--expanded) { margin-bottom: -10px; border-bottom: 0; border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
.byok-editor--expanded { grid-column: 1; }
.byok-editor-enter-active { max-height: 420px; box-sizing: border-box; overflow: hidden; transition: max-height .32s cubic-bezier(.22,.61,.36,1), padding .24s ease-out; }
.byok-editor-leave-active { max-height: 420px; box-sizing: border-box; overflow: hidden; transition: max-height .34s cubic-bezier(.16, 1, .3, 1), padding .26s cubic-bezier(.16, 1, .3, 1); }
.byok-editor-enter-from, .byok-editor-leave-to { max-height: 0; padding-top: 0; padding-bottom: 0; }
.byok-editor-enter-to, .byok-editor-leave-from { max-height: 420px; }
.byok-editor .form-input { height: 34px; box-sizing: border-box; }
.byok-editor-title { color: var(--text-primary); font-size: 12px; font-weight: 650; }
.byok-editor-actions { display: flex; justify-content: flex-end; gap: 8px; }
.model-picker { position: relative; min-width: 0; }
.model-picker-row { display: flex; gap: 6px; }
.model-picker-row .form-input { min-width: 0; flex: 1; }
.model-options { position: absolute; z-index: 20; left: 0; right: 0; top: calc(100% + 4px); max-height: 180px; overflow-y: auto; padding: var(--popup-surface-padding); border: 1px solid var(--popup-surface-border); border-radius: var(--popup-surface-radius); background: var(--popup-surface-bg); box-shadow: var(--popup-surface-shadow), inset 0 1px 0 var(--popup-surface-highlight); backdrop-filter: var(--popup-surface-blur); -webkit-backdrop-filter: var(--popup-surface-blur); }
.model-option { display: block; width: 100%; padding: 7px 9px; border: 0; border-radius: var(--popup-item-radius); background: none; color: var(--popup-item-fg); text-align: left; cursor: pointer; }
.model-option:hover { background: var(--popup-item-bg-hover); }
.model-option-hint { padding: 7px 9px; color: var(--popup-item-fg-muted); font-size: 12px; }
.api-format-field { grid-column: 1 / -1; }
:deep(.byok-editor .multimodal-capabilities) { grid-column: 1 / -1; width: 100%; }
.byok-editor .multimodal-capability-row { max-width: 360px; }
.field-label { display: block; margin-bottom: 5px; color: var(--text-secondary); font-size: 11px; }
.api-format-grid { display: flex; gap: 6px; }
@media (max-width: 680px) { .byok-card-grid { grid-template-columns: 1fr; } .byok-card { align-items: flex-start; flex-wrap: wrap; } .byok-card-actions { width: 100%; } .byok-form-grid { grid-template-columns: 1fr; } }
</style>
