<template>
  <BaseModal :show="show" width="620px" background="var(--modal-card-bg)" teleport-to="body" @close="$emit('close')">
    <div class="preset-editor-content">
      <h4 class="modal-title">{{ t(isNew ? 'adminLlmUi.newPreset' : 'adminLlmUi.editPreset') }}</h4>
      <div class="modal-field">
        <div class="modal-label">{{ t('adminLlmUi.presetName') }}</div>
        <input v-model="draft.name" class="form-input" :aria-label="t('adminLlmUi.presetName')" :placeholder="t('llmExtraUi.modelNamePlaceholder')" />
      </div>
      <SpeechModelFields :draft="draft" v-model:api-key="draft.api_key" :keep-key="!!draft.has_api_key" :load-models="loadModels" />
      <div class="modal-actions">
        <span class="save-hint" :class="{ error: !!error }" role="status">{{ error || message }}</span>
        <button type="button" class="btn-ghost" :disabled="testing || saving || !canSave" @click="$emit('test')">{{ t(testing ? 'agent.testing' : 'agent.test') }}</button>
        <button type="button" class="btn-ghost" :disabled="saving" @click="$emit('close')">{{ t('adminLlmUi.cancel') }}</button>
        <button type="button" class="btn-primary" :disabled="saving || testing || !canSave" @click="$emit('save')">{{ t(saving ? 'adminLlmUi.saving' : 'adminLlmUi.save') }}</button>
      </div>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { computed, type PropType } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseModal from '@/components/common/overlays/BaseModal.vue'
import SpeechModelFields from '@/components/common/models/SpeechModelFields.vue'
import type { VoicePresetDraft } from '../useVoicePresets'

const props = defineProps({
  show: Boolean,
  draft: { type: Object as PropType<VoicePresetDraft>, required: true },
  isNew: Boolean,
  saving: Boolean,
  testing: Boolean,
  error: { type: String, default: '' },
  message: { type: String, default: '' },
  loadModels: { type: Function as PropType<() => Promise<string[]>>, required: true },
})
defineEmits<{ close: []; save: []; test: [] }>()
const { t } = useI18n()
const canSave = computed(() => !!props.draft.name.trim() && !!props.draft.model.trim())
</script>

<style scoped src="../../components/model-preset-editor.css"></style>
