<template>
  <section class="config-card">
    <div class="card-head">
      <div class="card-icon"><Icon name="admin.brain" size="sm" /></div>
      <div class="card-title-block"><h3>记忆召回</h3><p>管理自动 RAG 开关、词法召回和可选的向量模型。向量模型只影响语义召回，不改变聊天模型。</p></div>
    </div>

    <div class="behavior-grid">
      <div class="behavior-item full-row">
        <div class="behavior-label"><span>自动知识召回（RAG）</span><span class="behavior-desc">关闭后本轮不自动检索 Memory、群组记忆或其他已接入知识源；显式工具仍按工具权限执行。</span></div>
        <button type="button" class="toggle-switch" :class="{ on: ragEnabled }" :aria-pressed="ragEnabled" @click="ragEnabled = !ragEnabled"><span class="toggle-knob" /></button>
      </div>
      <div class="behavior-item full-row">
        <div class="behavior-label"><span>向量 Embedding</span><span class="behavior-desc">关闭＝使用词法相关性；开启后供记忆语义召回使用。换模型或维度后需要重建向量。</span></div>
        <button type="button" class="toggle-switch" :class="{ on: embeddingDraft.enabled }" :aria-pressed="embeddingDraft.enabled" @click="embeddingDraft.enabled = !embeddingDraft.enabled"><span class="toggle-knob" /></button>
      </div>
      <div class="behavior-item full-row">
        <div class="behavior-label"><span>多模态 Embedding</span><span class="behavior-desc">百炼填写 qwen3-vl-embedding；开启后供图片/视频向量调用使用。</span></div>
        <button type="button" class="toggle-switch" :class="{ on: embeddingDraft.multimodal }" :aria-pressed="embeddingDraft.multimodal" @click="embeddingDraft.multimodal = !embeddingDraft.multimodal"><span class="toggle-knob" /></button>
      </div>
      <div class="behavior-item full-row"><div class="behavior-label"><span>提供方 provider</span><span class="behavior-desc">选择向量服务商；通用兼容用于其他 OpenAI 兼容端点。</span></div><AdminSelect :model-value="embeddingDraft.provider" :options="[{ value: 'bailian', label: '百炼（Bailian）' }, { value: 'openai', label: 'OpenAI' }, { value: 'ollama', label: 'Ollama' }, { value: '', label: '通用 OpenAI 兼容' }]" @update:model-value="embeddingDraft.provider = $event" /></div>
      <div class="behavior-item full-row"><div class="behavior-label"><span>模型名 model</span><span class="behavior-desc">百炼填 text-embedding-v4；Ollama 填 qwen3-embedding:0.6b。</span></div><input v-model="embeddingDraft.model" class="behavior-input" placeholder="qwen3-embedding:0.6b" /></div>
      <div class="behavior-item full-row"><div class="behavior-label"><span>Base URL</span><span class="behavior-desc">填到 /v1 那一层，不含 /embeddings。</span></div><input v-model="embeddingDraft.base_url" class="behavior-input" placeholder="http://…:11434/v1" /></div>
      <div class="behavior-item full-row"><div class="behavior-label"><span>API Key<span v-if="configStore.secretSet.embeddingApiKey" class="secret-mark">· 已配置 ✓</span></span><span class="behavior-desc">Ollama 可留空；已存 Key 留空表示保留不变。</span></div><input v-model="embeddingDraft.api_key" class="behavior-input" type="password" autocomplete="new-password" :placeholder="configStore.secretSet.embeddingApiKey ? '已配置，留空＝不修改' : 'Ollama 可留空'" /></div>
      <div class="behavior-item full-row"><div class="behavior-label"><span>维度 dimensions</span><span class="behavior-desc">0 使用模型默认维度；改维度后需要重建向量。</span></div><input v-model.number="embeddingDraft.dimensions" class="behavior-input" type="number" placeholder="0（模型默认）" /></div>
      <div class="behavior-item full-row"><div class="behavior-label"><span>连通测试</span><span class="behavior-desc">用当前表单参数测试 embedding 端点。</span></div><div class="action-row"><span v-if="embTest.msg" class="action-message" :class="{ error: !embTest.ok }">{{ embTest.msg }}</span><button class="btn-ghost" :disabled="embTest.loading" @click="testEmbedding">{{ embTest.loading ? '测试中…' : '测试' }}</button></div></div>
      <div class="behavior-item full-row"><div class="behavior-label"><span>重建向量</span><span class="behavior-desc">换模型或维度后，为已有记忆重新生成向量；期间检索自动退回词法。</span></div><div class="action-row"><span v-if="rebuild.msg" class="action-message" :class="{ error: rebuild.error }">{{ rebuild.msg }}</span><button class="btn-ghost" :disabled="rebuild.running" @click="startRebuild">{{ rebuild.running ? `重建中… ${rebuild.done}/${rebuild.total}` : '重建向量' }}</button></div></div>
    </div>
    <div class="card-actions"><span class="save-hint" :class="{ error: !!ragError || !!embeddingError }"><template v-if="ragSaved || embeddingSaved">已保存</template><template v-else>{{ ragError || embeddingError }}</template></span><button class="btn-ghost" @click="resetRag(); resetEmbedding()">撤销修改</button><button class="btn-primary" :disabled="ragSaving || embeddingSaving" @click="saveAll">{{ ragSaving || embeddingSaving ? '保存中…' : '保存' }}</button></div>
  </section>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import Icon from '@/components/common/Icon.vue'
import AdminSelect from '@/components/AdminSelect.vue'
import { useMemoryRecallConfig } from '../useMemoryRecallConfig'
const { configStore, embeddingDraft, ragEnabled, ragSaving, ragSaved, ragError, embeddingSaving, embeddingSaved, embeddingError, embTest, rebuild, startRebuild, resetEmbedding, resetRag, syncFromStore, saveAll, testEmbedding } = useMemoryRecallConfig()
onMounted(async () => { await configStore.fetchConfig(); syncFromStore() })
</script>

<style scoped>
.config-card{background:var(--panel-glass-bg);border:1px solid var(--panel-glass-border);border-radius:var(--radius-lg);padding:22px 24px;color:var(--content-primary);box-shadow:var(--elevation-card);backdrop-filter:var(--panel-glass-blur);-webkit-backdrop-filter:var(--panel-glass-blur)}
.card-head{display:flex;align-items:center;gap:13px;margin-bottom:20px}.card-icon{width:38px;height:38px;border-radius:11px;background:var(--selection-bg);color:var(--action-primary);display:flex;align-items:center;justify-content:center;flex:0 0 38px}.card-title-block{flex:1;min-width:0}.card-title-block h3{color:var(--content-primary);font-size:var(--font-size-md,14px);font-weight:700}.card-title-block p{margin-top:3px;color:var(--content-tertiary);font-size:var(--font-size-sm,12px);line-height:1.5}.behavior-grid{display:flex;flex-direction:column;gap:2px}.behavior-item{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;border-bottom:1px solid var(--panel-divider)}.behavior-item:last-child{border-bottom:0}.full-row{grid-column:1/-1}.behavior-label{display:flex;flex-direction:column;gap:3px;min-width:0}.behavior-label>span:first-child{color:var(--content-primary);font-size:13px;font-weight:500}.behavior-desc{color:var(--content-tertiary);font-size:12px;line-height:1.5}.behavior-input{width:280px;box-sizing:border-box;padding:7px 10px;border:1px solid var(--border-subtle);border-radius:var(--radius-sm);background:var(--surface-glass);color:var(--content-primary);outline:none}.behavior-input:focus{border-color:var(--action-primary)}.secret-mark{margin-left:6px;color:var(--status-success);font-size:11px}.toggle-switch{position:relative;display:inline-flex;align-items:center;width:42px;height:24px;padding:0;border:1px solid var(--border-subtle);border-radius:var(--radius-pill);background:var(--surface-soft);cursor:pointer}.toggle-switch.on{background:var(--action-primary);border-color:var(--action-primary)}.toggle-knob{width:16px;height:16px;margin:3px;border-radius:50%;background:var(--content-on-accent);transition:transform var(--motion-fast) var(--motion-ease)}.toggle-switch.on .toggle-knob{transform:translateX(18px)}.action-row,.card-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px}.card-actions{margin-top:18px;padding-top:16px;border-top:1px solid var(--panel-divider)}.action-message,.save-hint{max-width:420px;overflow:hidden;color:var(--status-success);font-size:12px;text-overflow:ellipsis;white-space:nowrap}.action-message.error,.save-hint.error{color:var(--status-danger)}.btn-ghost,.btn-primary{display:inline-flex;align-items:center;justify-content:center;min-height:30px;padding:6px 14px;border-radius:var(--radius-sm);font-size:13px;cursor:pointer;white-space:nowrap}.btn-ghost{border:1px solid var(--border-subtle);background:var(--surface-glass);color:var(--content-secondary)}.btn-primary{border:0;background:var(--action-primary-bg);color:var(--content-on-accent);font-weight:600}.btn-ghost:disabled,.btn-primary:disabled{opacity:.5;cursor:default}@media(max-width:720px){.behavior-item{align-items:flex-start;flex-direction:column}.behavior-input{width:100%}.card-actions{justify-content:flex-start;flex-wrap:wrap}}
/* Agent 记忆开关复用 Admin 通用控件 motion contract。 */
.toggle-switch { flex: 0 0 42px; border-color: var(--control-border); background: var(--control-bg); box-shadow: inset 0 1px 0 color-mix(in srgb, var(--content-primary) 8%, transparent); transition: background var(--motion-fast) var(--motion-ease-standard), border-color var(--motion-fast) var(--motion-ease-standard), box-shadow var(--motion-fast) var(--motion-ease-standard); }
.toggle-switch:hover { border-color: var(--control-border-hover); background: var(--control-bg-hover); }
.toggle-switch:focus-visible { outline: none; box-shadow: var(--control-focus-shadow); }
.toggle-knob { width: 18px; height: 18px; margin: 0 0 0 2px; box-shadow: var(--elevation-control, 0 1px 3px color-mix(in srgb, var(--content-primary) 18%, transparent)); transition: transform var(--motion-fast) var(--motion-ease-standard); }
.toggle-switch:disabled { opacity: .5; cursor: default; }
</style>
