<template>
  <section>
    <div class="presets-header">
      <div>
        <h3 class="presets-title">{{ t('agent.voiceTitle') }}</h3>
        <p class="presets-desc">{{ t('agentConfigUi.voiceHint') }}</p>
      </div>
      <button type="button" class="btn-primary" @click="openCreate">＋ {{ t('agentConfigUi.voiceAddPreset') }}</button>
    </div>
    <div v-if="loading" class="presets-loading" role="status">{{ t('agent.loading') }}</div>
    <div v-else class="preset-list">
      <p v-if="!items.length" class="presets-desc">{{ t('agentConfigUi.voiceEmpty') }}</p>
      <article v-for="item in items" :key="item.id" class="preset-card" :class="{ 'preset-card--active': item.id === activeId }">
        <div class="preset-card-left"><span class="provider-dot" :class="`dot-${item.provider}`" aria-hidden="true"></span></div>
        <div class="preset-card-body">
          <div class="preset-card-top">
            <span class="preset-name">{{ item.name }}</span>
            <span v-if="item.id === activeId" class="active-badge">{{ t('agent.current') }}</span>
            <span class="provider-label">{{ providerLabel(item.provider) }}</span>
          </div>
          <div class="preset-card-meta">
            <span class="preset-model">{{ item.model }}</span>
            <span class="preset-meta-item">{{ item.api_format }}</span>
            <span class="preset-key">{{ item.api_key || t('agent.unsetKey') }}</span>
          </div>
        </div>
        <div class="preset-card-actions">
          <button type="button" class="pca-btn" @click="openEdit(item)">{{ t('agent.edit') }}</button>
          <button type="button" class="pca-btn" :disabled="testing" @click="test({ ...item, api_key: '' })">{{ t(testing ? 'agent.testing' : 'agent.test') }}</button>
          <button v-if="item.id !== activeId" type="button" class="pca-btn pca-btn--activate" :disabled="!!activatingId" @click="activate(item.id)">{{ t(activatingId === item.id ? 'agent.switching' : 'agentConfigUi.voiceUse') }}</button>
          <button v-else type="button" class="pca-btn" :disabled="!!activatingId" @click="confirmDeactivate">{{ t('agentConfigUi.voiceDeactivate') }}</button>
          <button type="button" class="pca-btn pca-btn--del" :disabled="!!deletingId" @click="confirmDelete(item)">{{ t('agent.delete') }}</button>
        </div>
      </article>
    </div>
    <div v-if="message && !editorOpen" class="llm-msg" :class="{ 'llm-msg--error': messageIsError }" role="status">{{ message }}</div>
    <VoicePresetEditor :show="editorOpen" :draft="draft" :is-new="isNew" :saving="saving" :testing="testing" :error="error" :message="message" :load-models="() => loadModels(draft)" @close="editorOpen = false" @save="saveDraft" @test="testDraft" />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { MODEL_PROVIDERS } from '@/utils/modelProviders'
import { speechProviderDefaults } from '@/utils/speechModelConfig'
import VoicePresetEditor from './VoicePresetEditor.vue'
import { useVoicePresets, type VoicePreset, type VoicePresetDraft } from '../useVoicePresets'

const { t } = useI18n()
const voice = useVoicePresets()
const { items, activeId, loading, saving, activatingId, deletingId, testing, error, message, messageIsError, fetchItems, save, activate, deactivate, remove, test, loadModels, resetFeedback } = voice
const editorOpen = ref(false)
const isNew = ref(true)
const draft = ref<VoicePresetDraft>(emptyDraft())
const providerLabels = computed(() => Object.fromEntries(MODEL_PROVIDERS.map(item => [item.value, t(item.labelKey)])))

function emptyDraft(): VoicePresetDraft {
  return { name: '', ...speechProviderDefaults('openai'), dashscope_service: 'qwen3-asr' } as VoicePresetDraft
}

function providerLabel(provider: string) {
  return providerLabels.value[provider] || provider
}

function openCreate() {
  resetFeedback()
  isNew.value = true
  draft.value = emptyDraft()
  editorOpen.value = true
}

function openEdit(item: VoicePreset) {
  resetFeedback()
  isNew.value = false
  draft.value = { ...item, api_key: '' }
  editorOpen.value = true
}

async function saveDraft() {
  if (await save(draft.value)) editorOpen.value = false
}

async function testDraft() {
  await test(draft.value)
}

async function confirmDeactivate() {
  if (await confirmDialog({ title: t('agentConfigUi.voiceDeactivate'), message: t('agentConfigUi.voiceDeactivateMessage'), confirmText: t('agentConfigUi.voiceDeactivate') })) await deactivate()
}

async function confirmDelete(item: VoicePreset) {
  const confirmed = await confirmDialog({
    title: t('agentConfigUi.voiceDeleteTitle'),
    message: t('agentConfigUi.voiceDeleteMessage', { name: item.name }),
    tone: 'danger',
    confirmText: t('agent.delete'),
  })
  if (confirmed) await remove(item.id)
}

onMounted(fetchItems)
</script>


<style scoped src="../../components/model-presets.css"></style>
