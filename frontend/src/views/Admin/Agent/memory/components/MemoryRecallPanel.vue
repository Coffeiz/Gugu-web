<template>
  <section class="config-card">
    <div class="card-head">
      <div class="card-icon"><Icon name="admin.brain" size="sm" /></div>
      <div class="card-title-block"><h3>{{ t('adminAgentMemory.recallTitle') }}</h3><p>{{ t('adminAgentMemory.recallDescription') }}</p></div>
    </div>

    <div class="behavior-grid">
      <div class="behavior-item full-row">
        <div class="behavior-label"><span>{{ t('adminAgentMemory.rag') }}</span><span class="behavior-desc">{{ t('adminAgentMemory.ragHint') }}</span></div>
        <AgentMemoryToggle v-model="ragEnabled" :ariaLabel="t('adminAgentMemory.toggleRag')" />
      </div>
      <div class="section-label full-row">{{ t('adminAgentMemory.capability') }}</div>
      <div class="behavior-item full-row">
        <div class="behavior-label"><span>{{ t('adminAgentMemory.capability') }}</span><span class="behavior-desc">{{ t('adminAgentMemory.capabilityHint') }}</span></div>
        <AgentMemoryToggle v-model="capabilityRagEnabled" :ariaLabel="t('adminAgentMemory.toggleCapability')" />
      </div>
      <div class="behavior-item full-row" :class="{ 'is-disabled': !capabilityRagEnabled }">
        <div class="behavior-label"><span>{{ t('adminAgentMemory.shadow') }}</span><span class="behavior-desc">{{ t('adminAgentMemory.shadowHint') }}</span></div>
        <AgentMemoryToggle v-model="capabilityRagShadow" :ariaLabel="t('adminAgentMemory.toggleShadow')" :disabled="!capabilityRagEnabled" />
      </div>
      <div class="behavior-item full-row" :class="{ 'is-disabled': !capabilityRagEnabled }">
        <div class="behavior-label"><span>{{ t('adminAgentMemory.limit') }}</span><span class="behavior-desc">{{ t('adminAgentMemory.limitHint') }}</span></div>
        <input v-model.number="capabilityRagLimit" class="behavior-input compact-input" type="number" min="1" max="20" step="1" :disabled="!capabilityRagEnabled" />
      </div>
      <div class="behavior-item full-row">
        <div class="behavior-label"><span>{{ t('adminAgentMemory.embedding') }}</span><span class="behavior-desc">{{ t('adminAgentMemory.embeddingHint') }}</span></div>
        <AgentMemoryToggle v-model="embeddingDraft.enabled" :ariaLabel="t('adminAgentMemory.toggleEmbedding')" />
      </div>
      <div class="behavior-item full-row">
        <div class="behavior-label"><span>{{ t('adminAgentMemory.multimodal') }}</span><span class="behavior-desc">{{ t('adminAgentMemory.multimodalHint') }}</span></div>
        <AgentMemoryToggle v-model="embeddingDraft.multimodal" :ariaLabel="t('adminAgentMemory.toggleMultimodal')" />
      </div>
      <div class="behavior-item full-row"><div class="behavior-label"><span>{{ t('adminAgentMemory.provider') }}</span><span class="behavior-desc">{{ t('adminAgentMemory.providerHint') }}</span></div><AdminSelect :model-value="embeddingDraft.provider" :options="[{ value: 'bailian', label: '百炼（Bailian）' }, { value: 'openai', label: 'OpenAI' }, { value: 'ollama', label: 'Ollama' }, { value: '', label: t('adminAgentMemory.genericProvider') }]" @update:model-value="embeddingDraft.provider = $event" /></div>
      <div class="behavior-item full-row"><div class="behavior-label"><span>{{ t('adminAgentMemory.model') }}</span><span class="behavior-desc">{{ t('adminAgentMemory.modelHint') }}</span></div><input v-model="embeddingDraft.model" class="behavior-input" placeholder="qwen3-embedding:0.6b" /></div>
      <div class="behavior-item full-row"><div class="behavior-label"><span>{{ t('adminAgentMemory.baseUrl') }}</span><span class="behavior-desc">{{ t('adminAgentMemory.baseUrlHint') }}</span></div><input v-model="embeddingDraft.base_url" class="behavior-input" placeholder="http://…:11434/v1" /></div>
      <div class="behavior-item full-row"><div class="behavior-label"><span>{{ t('adminAgentMemory.apiKey') }}<span v-if="configStore.secretSet.embeddingApiKey" class="secret-mark">· ✓</span></span><span class="behavior-desc">{{ t('adminAgentMemory.apiKeyHint') }}</span></div><input v-model="embeddingDraft.api_key" class="behavior-input" type="password" autocomplete="new-password" :placeholder="configStore.secretSet.embeddingApiKey ? t('adminAgentMemory.configuredKeep') : t('adminAgentMemory.ollamaEmpty')" /></div>
      <div class="behavior-item full-row"><div class="behavior-label"><span>{{ t('adminAgentMemory.dimensions') }}</span><span class="behavior-desc">{{ t('adminAgentMemory.dimensionsHint') }}</span></div><input v-model.number="embeddingDraft.dimensions" class="behavior-input number-input" type="number" :placeholder="t('adminAgentMemory.defaultDimensions')" /></div>
      <div class="behavior-item full-row"><div class="behavior-label"><span>{{ t('adminAgentMemory.testConnection') }}</span><span class="behavior-desc">{{ t('adminAgentMemory.testHint') }}</span></div><div class="action-row"><span v-if="embTest.msg" class="action-message" :class="{ error: !embTest.ok }">{{ embTest.msg }}</span><button class="btn-ghost" :disabled="embTest.loading" @click="testEmbedding">{{ embTest.loading ? t('adminAgentMemory.testing') : t('adminAgentMemory.test') }}</button></div></div>
      <div class="behavior-item full-row"><div class="behavior-label"><span>{{ t('adminAgentMemory.rebuild') }}</span><span class="behavior-desc">{{ t('adminAgentMemory.rebuildHint') }}</span></div><div class="action-row"><span v-if="rebuild.msg" class="action-message" :class="{ error: rebuild.error }">{{ rebuild.msg }}</span><button class="btn-ghost" :disabled="rebuild.running" @click="startRebuild">{{ rebuild.running ? `${t('adminAgentMemory.rebuilding')} ${rebuild.done}/${rebuild.total}` : t('adminAgentMemory.rebuild') }}</button></div></div>
    </div>
    <div class="card-actions"><span class="save-hint" :class="{ error: !!ragError || !!embeddingError }"><template v-if="ragSaved || embeddingSaved">{{ t('adminAgentMemory.saved') }}</template><template v-else>{{ ragError || embeddingError }}</template></span><button class="btn-ghost" @click="resetRag(); resetEmbedding()">{{ t('adminAgentMemory.undo') }}</button><button class="btn-primary" :disabled="ragSaving || embeddingSaving" @click="saveAll">{{ ragSaving || embeddingSaving ? t('adminAgentMemory.saving') : t('adminAgentMemory.save') }}</button></div>
  </section>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/icons/Icon.vue'
import AdminSelect from '@/components/AdminSelect.vue'
import AgentMemoryToggle from './AgentMemoryToggle.vue'
import { useMemoryRecallConfig } from '../useMemoryRecallConfig'
const { configStore, embeddingDraft, ragEnabled, capabilityRagEnabled, capabilityRagShadow, capabilityRagLimit, ragSaving, ragSaved, ragError, embeddingSaving, embeddingSaved, embeddingError, embTest, rebuild, startRebuild, resetEmbedding, resetRag, syncFromStore, saveAll, testEmbedding } = useMemoryRecallConfig()
const { t } = useI18n()
onMounted(async () => { await configStore.fetchConfig(); syncFromStore() })
</script>

<style scoped>
.config-card{background:var(--panel-glass-bg);border:1px solid var(--panel-glass-border);border-radius:var(--radius-lg);padding:22px 24px;color:var(--content-primary);box-shadow:var(--elevation-card);backdrop-filter:var(--panel-glass-blur);-webkit-backdrop-filter:var(--panel-glass-blur)}
.card-head{display:flex;align-items:center;gap:13px;margin-bottom:20px}.card-icon{width:38px;height:38px;border-radius:11px;background:var(--selection-bg);color:var(--action-primary);display:flex;align-items:center;justify-content:center;flex:0 0 38px}.card-title-block{flex:1;min-width:0}.card-title-block h3{color:var(--content-primary);font-size:var(--font-size-md,14px);font-weight:700}.card-title-block p{margin-top:3px;color:var(--content-tertiary);font-size:var(--font-size-sm,12px);line-height:1.5}.behavior-grid{display:flex;flex-direction:column;gap:2px}.behavior-item{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;border-bottom:1px solid var(--panel-divider)}.behavior-item:last-child{border-bottom:0}.full-row{grid-column:1/-1}.behavior-label{display:flex;flex-direction:column;gap:3px;min-width:0}.behavior-label>span:first-child{color:var(--content-primary);font-size:13px;font-weight:500}.behavior-desc{color:var(--content-tertiary);font-size:12px;line-height:1.5}.behavior-input{width:280px;box-sizing:border-box;padding:7px 10px;border:1px solid var(--border-subtle);border-radius:var(--radius-sm);background:var(--surface-glass);color:var(--content-primary);outline:none}.behavior-input:focus{border-color:var(--action-primary)}.secret-mark{margin-left:6px;color:var(--status-success);font-size:11px}.action-row,.card-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px}.card-actions{margin-top:18px;padding-top:16px;border-top:1px solid var(--panel-divider)}.action-message,.save-hint{max-width:420px;overflow:hidden;color:var(--status-success);font-size:12px;text-overflow:ellipsis;white-space:nowrap}.action-message.error,.save-hint.error{color:var(--status-danger)}.btn-ghost,.btn-primary{display:inline-flex;align-items:center;justify-content:center;min-height:30px;padding:6px 14px;border-radius:var(--radius-sm);font-size:13px;cursor:pointer;white-space:nowrap}.btn-ghost{border:1px solid var(--border-subtle);background:var(--surface-glass);color:var(--content-secondary)}.btn-primary{border:0;background:var(--action-primary-bg);color:var(--content-on-accent);font-weight:600}.btn-ghost:disabled,.btn-primary:disabled{opacity:.5;cursor:default}@media(max-width:720px){.behavior-item{align-items:flex-start;flex-direction:column}.behavior-input{width:100%}.card-actions{justify-content:flex-start;flex-wrap:wrap}}
.section-label{padding:18px 0 4px;color:var(--content-secondary);font-size:12px;font-weight:700;letter-spacing:.02em}.behavior-item.is-disabled{opacity:.58}.compact-input,.number-input{width:96px;flex:0 0 96px;text-align:center}.behavior-input:disabled{cursor:not-allowed}
/* Agent 记忆开关复用 Admin 通用控件 motion contract。 */
</style>
