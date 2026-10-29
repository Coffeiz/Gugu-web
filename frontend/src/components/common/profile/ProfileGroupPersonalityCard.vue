<template>
  <div class="group-personality">
    <div class="personality-heading">
      <div class="pm-field-desc">
        <span class="pm-field-name">{{ t('personalityUi.groupPersona') }}</span>
        <span class="pm-field-hint">{{ t('personalityUi.groupPersonaHint') }}</span>
      </div>
      <div class="personality-toggle">
        <ToggleSwitch
          :model-value="enabled"
          :disabled="saving || !hasContent"
          :aria-label="t('personalityUi.groupPersonaEnable')"
          @update:model-value="onToggle"
        />
        <span class="personality-enabled-label">{{ enabled ? t('personalityUi.enabled') : t('personalityUi.disabled') }}</span>
      </div>
    </div>
    <div class="personality-file-card">
      <div class="personality-file-icon">MD</div>
      <div class="personality-file-info">
        <div class="personality-file-name">group-persona.md</div>
        <div class="personality-file-meta">
          {{ hasContent ? t('personalityUi.characters', { count: characterCount }) : t('personalityUi.notCreated') }} · {{ t('personalityUi.hidden') }}
        </div>
      </div>
      <div class="personality-file-actions">
        <input ref="fileInput" class="personality-file-input" type="file" accept=".md,text/markdown" @change="onFileSelected" />
        <button type="button" class="pm-text-button" :disabled="saving" @click="fileInput?.click()">{{ t('personalityUi.upload') }}</button>
        <button type="button" class="pm-text-button" :disabled="saving" @click="openEditor">{{ t('personalityUi.edit') }}</button>
      </div>
    </div>
    <div v-if="error || status" class="personality-status" :class="{ error: !!error }">{{ error || status }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ToggleSwitch from '@/components/common/controls/ToggleSwitch.vue'
import { usePreferencesStore } from '@/stores/preferences'
import { usePreviewStore } from '@/stores/preview'

const prefsStore = usePreferencesStore()
const previewStore = usePreviewStore()
const { t } = useI18n()
const enabled = ref(prefsStore.groupPersonalityPreferenceEnabled)
const saving = ref(false)
const status = ref('')
const error = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const hasContent = computed(() => !!prefsStore.groupPersonalityPreference.trim())
const characterCount = computed(() => Array.from(prefsStore.groupPersonalityPreference).length)

watch(() => prefsStore.groupPersonalityPreferenceEnabled, value => { enabled.value = value })

function openEditor() {
  status.value = ''
  error.value = ''
  previewStore.openVirtual(
    { id: -3, displayName: 'group-persona', ext: 'MD', size: `${characterCount.value} 字符` },
    prefsStore.groupPersonalityPreference,
    saveDocument,
  )
}

async function saveDocument(content: string) {
  saving.value = true
  status.value = ''
  error.value = ''
  try {
    await prefsStore.saveGroupPersonalityPreference(content, enabled.value)
    status.value = t('personalityUi.saved')
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('personalityUi.saveFailed')
    throw err
  } finally {
    saving.value = false
  }
}

async function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  saving.value = true
  status.value = ''
  error.value = ''
  try {
    await prefsStore.uploadGroupPersonalityFile(file)
    status.value = t('personalityUi.uploaded')
    openEditor()
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('personalityUi.uploadFailed')
  } finally {
    saving.value = false
  }
}

async function onToggle(value: boolean) {
  const previous = enabled.value
  enabled.value = value
  saving.value = true
  status.value = ''
  error.value = ''
  try {
    await prefsStore.saveGroupPersonalityPreference(prefsStore.groupPersonalityPreference, value)
    enabled.value = prefsStore.groupPersonalityPreferenceEnabled
    status.value = value ? t('personalityUi.groupPersonaEnabled') : t('personalityUi.groupPersonaDisabled')
  } catch (err) {
    enabled.value = previous
    error.value = err instanceof Error ? err.message : t('personalityUi.saveFailed')
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  if (!prefsStore.loaded) await prefsStore.fetch()
  enabled.value = prefsStore.groupPersonalityPreferenceEnabled
})
</script>

<style scoped>
.group-personality { display: grid; gap: 10px; }
.personality-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.personality-toggle { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.personality-enabled-label, .personality-status { color: var(--content-secondary); font-size: 12px; }
.personality-file-card { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 13px 14px; border: 1px solid var(--workspace-card-border); border-radius: var(--radius-md); background: var(--workspace-card-bg); box-shadow: var(--workspace-card-shadow); }
.personality-file-icon { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 8px; background: var(--action-soft); color: var(--action-primary); font: 700 10px var(--font-family-mono); }
.personality-file-info { min-width: 0; flex: 1; }
.personality-file-name { color: var(--content-primary); font-size: 13px; font-weight: 600; }
.personality-file-meta { margin-top: 3px; color: var(--content-tertiary); font-size: 11px; }
.personality-file-actions { display: flex; align-items: center; gap: 4px; }
.personality-file-input { display: none; }
.personality-status { color: var(--status-success); }
.personality-status.error { color: var(--status-danger); }
.pm-text-button { padding: 6px 8px; border: 0; border-radius: var(--radius-xs); background: transparent; color: var(--content-secondary); font: 12px var(--font-sans); cursor: pointer; transition: background-color var(--motion-hover-control) var(--motion-ease-standard), color var(--motion-hover-control) var(--motion-ease-standard); }
.pm-text-button:hover:not(:disabled) { background: var(--action-soft); color: var(--action-primary); }
.pm-text-button:disabled { opacity: .45; cursor: default; }
</style>
