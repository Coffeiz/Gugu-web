<template>
  <div class="pm-section personality-preference">
    <div class="pm-section-label">{{ t('personalityUi.title') }}</div>
    <div v-if="!prefsStore.personalityPreferenceAvailable" class="personality-locked">{{ t('personalityUi.locked') }}</div>
    <template v-else>
      <div class="personality-heading">
        <div class="pm-field-desc">
          <span class="pm-field-name">persona.md</span>
          <span class="pm-field-hint">{{ t('personalityUi.hint') }}</span>
        </div>
        <div class="personality-toggle">
          <ToggleSwitch :model-value="enabled" :disabled="saving || !hasContent" :aria-label="t('personalityUi.enable')" @update:model-value="onToggle" />
          <span class="personality-enabled-label">{{ enabled ? t('personalityUi.enabled') : t('personalityUi.disabled') }}</span>
        </div>
      </div>
      <div class="personality-file-card">
        <div class="personality-file-icon">MD</div>
        <div class="personality-file-info">
          <div class="personality-file-name">persona.md</div>
          <div class="personality-file-meta">{{ hasContent ? t('personalityUi.characters', { count: characterCount }) : t('personalityUi.notCreated') }} · {{ t('personalityUi.hidden') }}</div>
        </div>
        <div class="personality-file-actions">
          <input ref="fileInput" class="personality-file-input" type="file" accept=".md,text/markdown" @change="onFileSelected" />
          <button type="button" class="pm-text-button" :disabled="saving" @click="fileInput?.click()">{{ t('personalityUi.upload') }}</button>
          <button type="button" class="pm-text-button" :disabled="saving" @click="openEditor">{{ t('personalityUi.edit') }}</button>
        </div>
      </div>
      <div v-if="error || status" class="personality-status" :class="{ error: !!error }">{{ error || status }}</div>
      <ProfileGroupPersonalityCard />
    </template>
    <div class="personality-heading">
      <div class="pm-field-desc"><span class="pm-field-name">{{ t('personalityUi.customStyle') }}</span><span class="pm-field-hint">{{ t('personalityUi.customStyleHint') }}</span></div>
      <div class="personality-toggle">
        <ToggleSwitch :model-value="customEnabled" :disabled="customSaving || !hasCustomStyle" :aria-label="t('personalityUi.customStyleEnable')" @update:model-value="toggleCustomStyle" />
        <span class="personality-enabled-label">{{ customEnabled ? t('personalityUi.enabled') : t('personalityUi.disabled') }}</span>
      </div>
    </div>
    <div class="personality-file-card">
      <div class="personality-file-icon">MD</div>
      <div class="personality-file-info">
        <div class="personality-file-name">reply-style.md</div>
        <div class="personality-file-meta">{{ hasCustomStyle ? t('personalityUi.characters', { count: customCharacterCount }) : t('personalityUi.notCreated') }} · {{ t('personalityUi.hidden') }}</div>
      </div>
      <div class="personality-file-actions">
        <input ref="customFileInput" class="personality-file-input" type="file" accept=".md,.txt,text/markdown,text/plain" @change="onCustomFileSelected" />
        <button type="button" class="pm-text-button" :disabled="customSaving" @click="customFileInput?.click()">{{ t('personalityUi.upload') }}</button>
        <button type="button" class="pm-text-button" :disabled="customSaving" @click="openCustomEditor">{{ t('personalityUi.edit') }}</button>
      </div>
    </div>
    <div v-if="customError || customStatus" class="personality-status" :class="{ error: !!customError }">{{ customError || customStatus }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ToggleSwitch from '@/components/common/controls/ToggleSwitch.vue'
import ProfileGroupPersonalityCard from '@/components/common/profile/ProfileGroupPersonalityCard.vue'
import { usePreferencesStore } from '@/stores/preferences'
import { usePreviewStore } from '@/stores/preview'

const prefsStore = usePreferencesStore()
const { t } = useI18n()
const previewStore = usePreviewStore()
const enabled = ref(false)
const customEnabled = ref(false)
const customSaving = ref(false)
const customStatus = ref('')
const customError = ref('')
const customFileInput = ref<HTMLInputElement | null>(null)
const hasCustomStyle = computed(() => !!prefsStore.customReplyStyle.trim())
const customCharacterCount = computed(() => Array.from(prefsStore.customReplyStyle).length)

function openCustomEditor() {
  customStatus.value = ''; customError.value = ''
  previewStore.openVirtual(
    { id: -2, displayName: 'reply-style', ext: 'MD', size: `${customCharacterCount.value} 字符` },
    prefsStore.customReplyStyle,
    saveCustomDocument,
  )
}

async function saveCustomDocument(content: string) {
  customSaving.value = true; customError.value = ''; customStatus.value = ''
  try {
    await prefsStore.saveCustomReplyStyle(content)
    customStatus.value = t('personalityUi.saved')
  } catch (err) {
    customError.value = err instanceof Error ? err.message : t('personalityUi.saveFailed')
    throw err
  } finally { customSaving.value = false }
}

async function onCustomFileSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  customSaving.value = true; customStatus.value = ''; customError.value = ''
  try {
    await prefsStore.uploadCustomReplyStyle(file)
    customStatus.value = t('personalityUi.uploaded')
    openCustomEditor()
  } catch (err) {
    customError.value = err instanceof Error ? err.message : t('personalityUi.uploadFailed')
  } finally { customSaving.value = false }
}
async function toggleCustomStyle(value: boolean) {
  const previous = customEnabled.value
  customEnabled.value = value
  customSaving.value = true; customError.value = ''; customStatus.value = ''
  try {
    const data = await prefsStore.saveCustomReplyStyleEnabled(value)
    customEnabled.value = data.customReplyStyleEnabled ?? value
  } catch (err) {
    customEnabled.value = previous
    customError.value = err instanceof Error ? err.message : t('personalityUi.saveFailed')
  } finally { customSaving.value = false }
}
const saving = ref(false)
const status = ref('')
const error = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
let statusTimer: number | null = null
const hasContent = computed(() => !!prefsStore.personalityPreference.trim())
const characterCount = computed(() => Array.from(prefsStore.personalityPreference).length)

function syncFromStore() { enabled.value = prefsStore.personalityPreferenceEnabled }
function openEditor() {
  status.value = ''; error.value = ''
  previewStore.openVirtual(
    { id: -1, displayName: 'persona', ext: 'MD', size: `${characterCount.value} 字符` },
    prefsStore.personalityPreference,
    saveDocument,
  )
}

async function saveDocument(content: string) {
  await prefsStore.savePersonalityPreference(content, enabled.value)
  status.value = t('personalityUi.saved')
  error.value = ''
}

async function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  saving.value = true; status.value = ''; error.value = ''
  try {
    await prefsStore.uploadPersonalityFile(file)
    status.value = t('personalityUi.uploaded')
    openEditor()
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('personalityUi.uploadFailed')
  } finally { saving.value = false }
}

async function onToggle(value: boolean) {
  const previous = enabled.value
  if (statusTimer !== null) { window.clearTimeout(statusTimer); statusTimer = null }
  enabled.value = value; saving.value = true; error.value = ''
  try {
    await prefsStore.savePersonalityPreference(prefsStore.personalityPreference, value)
    status.value = value ? '人格偏好已启用' : '人格偏好已停用'
    statusTimer = window.setTimeout(() => { status.value = ''; statusTimer = null }, 2400)
  } catch (err) {
    enabled.value = previous
    error.value = err instanceof Error ? err.message : '保存失败，请稍后重试'
  } finally { saving.value = false }
}

onMounted(async () => { if (!prefsStore.loaded) await prefsStore.fetch(); syncFromStore(); customEnabled.value = prefsStore.customReplyStyleEnabled })
onUnmounted(() => { if (statusTimer !== null) window.clearTimeout(statusTimer) })
</script>

<style scoped>
.personality-preference { gap: 12px; }
.personality-locked { padding: 10px 12px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--surface-soft); color: var(--content-secondary); font-size: 12px; line-height: 1.6; }
.personality-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.personality-toggle { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.personality-file-card { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 13px 14px; border: 1px solid var(--workspace-card-border); border-radius: var(--radius-md); background: var(--workspace-card-bg); box-shadow: var(--workspace-card-shadow); transition: background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), box-shadow var(--motion-hover-control) var(--motion-ease-standard); }
.personality-file-card:hover { border-color: var(--theme-action-primary); background: var(--workspace-card-bg); box-shadow: var(--workspace-card-shadow); }
.personality-file-icon { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 8px; background: var(--action-soft); color: var(--action-primary); font: 700 10px var(--font-family-mono); }
.personality-file-info { min-width: 0; flex: 1; }
.personality-file-name { color: var(--content-primary); font-size: 13px; font-weight: 600; }
.personality-file-meta { margin-top: 3px; color: var(--content-tertiary); font-size: 11px; }
.personality-file-actions { display: flex; align-items: center; gap: 4px; }
.personality-file-input { display: none; }
.personality-enabled-label, .personality-status { color: var(--content-secondary); font-size: 12px; }
.personality-status { padding: 2px 0; color: var(--status-success); }
.personality-status.error { color: var(--status-danger); }
.pm-text-button { padding: 6px 8px; border: 0; border-radius: var(--radius-xs); background: transparent; color: var(--content-secondary); font: 12px var(--font-sans); cursor: pointer; transition: background-color var(--motion-hover-control) var(--motion-ease-standard), color var(--motion-hover-control) var(--motion-ease-standard); }
.pm-text-button:hover:not(:disabled) { background: var(--action-soft); color: var(--action-primary); }
.pm-text-button:disabled { opacity: .45; cursor: default; }
</style>
