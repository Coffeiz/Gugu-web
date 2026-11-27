<template>
  <div>
    <div class="pm-section">
      <div class="pm-section-label">{{ t('profileToolUi.toolDefinition') }}</div>
      <div class="pm-field-row">
        <div class="pm-field-desc"><span class="pm-field-name">{{ t('profileToolUi.schemaMode') }}</span><span class="pm-field-hint">{{ t('profileToolUi.schemaHint') }}</span></div>
        <div class="pm-style-group">
          <button class="pm-style-chip" :class="{ active: prefsStore.toolInjectionMode === 'description' }" @click="prefsStore.saveToolInjectionMode('description')">{{ t('profileToolUi.descriptionMode') }}</button>
          <button class="pm-style-chip" :class="{ active: prefsStore.toolInjectionMode === 'full' }" @click="prefsStore.saveToolInjectionMode('full')">{{ t('profileToolUi.fullMode') }}</button>
        </div>
      </div>
    </div>
    <div v-if="!desktop" class="pm-sep"></div>
    <div v-if="!desktop" class="pm-section smtp-section">
      <div class="pm-section-label">{{ t('profileToolUi.smtpTitle') }}</div>
      <p class="pm-field-hint">{{ t('profileToolUi.smtpHint') }}</p>
      <div class="smtp-grid">
        <input v-model="smtp.host" class="form-input" :placeholder="t('profileToolUi.smtpHost')" autocomplete="off" />
        <input v-model.number="smtp.port" class="form-input" type="number" min="1" max="65535" :placeholder="t('profileToolUi.smtpPort')" />
        <input v-model="smtp.user" class="form-input" :placeholder="t('profileToolUi.smtpUser')" autocomplete="username" />
        <input v-model="smtp.password" class="form-input" type="password" :placeholder="smtp.configured ? t('profileToolUi.smtpPasswordKeep') : t('profileToolUi.smtpPassword')" autocomplete="new-password" />
        <input v-model="smtp.fromAddr" class="form-input" :placeholder="t('profileToolUi.smtpFrom')" autocomplete="off" />
        <input v-model="smtp.toAddr" class="form-input" :placeholder="t('profileToolUi.smtpTo')" autocomplete="email" />
      </div>
      <div class="smtp-actions">
        <Checkbox v-model="smtp.enabled" class="smtp-enabled">{{ t('profileToolUi.smtpEnabled') }}</Checkbox>
        <Checkbox v-model="smtp.useSsl" class="smtp-ssl">{{ t('profileToolUi.smtpSsl') }}</Checkbox>
        <button class="pm-style-chip" :disabled="smtp.testing || !smtp.host" @click="testSmtp">{{ smtp.testing ? t('profileToolUi.testing') : t('profileToolUi.smtpTest') }}</button>
        <button class="pm-style-chip" :disabled="smtp.saving || !smtp.host" @click="saveSmtp">{{ smtp.saving ? t('sharedUi.saving') : t('sharedUi.save') }}</button>
      </div>
      <div v-if="smtpMessage" class="pm-msg" :class="smtpMessageType">{{ smtpMessage }}</div>
    </div>
    <div class="pm-sep"></div>
    <div class="pm-section">
      <div class="pm-section-label">{{ t('profileToolUi.capabilityCredentials') }}</div>
      <p class="pm-field-hint">{{ t(desktop ? 'profileToolUi.desktopCapabilityHint' : 'profileToolUi.capabilityHint') }}</p>
      <div v-for="item in capabilityItems" :key="item.capability" class="pm-field-row capability-row">
        <div class="pm-field-desc"><span class="pm-field-name">{{ t(item.labelKey) }}</span><span class="pm-field-hint">{{ t(item.hintKey) }}</span></div>
        <div class="capability-editor"><AdminSelect v-model="item.provider" :options="providersFor(item.capability)" :placeholder="t('profileToolUi.selectProvider')" /><input v-model="item.value" class="form-input" type="password" autocomplete="new-password" :placeholder="t('profileToolUi.keepKeyPlaceholder')" /><button class="pm-style-chip" :disabled="item.saving || !item.provider || item.provider === serverDefault || (!item.value && (!item.id || item.savedProvider !== item.provider)) || testingCapability !== null" :title="item.provider === serverDefault ? t('profileToolUi.defaultCannotTest') : t('profileToolUi.testCurrent')" @click="testCapability(item)">{{ testingCapability === (item.id ?? -1) ? t('profileToolUi.testing') : t('common.actions.test') }}</button><button class="pm-style-chip" :disabled="item.saving || !item.provider" @click="saveCapability(item)">{{ item.saving ? t('sharedUi.saving') : item.id ? t('common.actions.update') : t('sharedUi.save') }}</button></div>
      </div>
      <div v-if="capabilityMessage" class="pm-msg" :class="capabilityMessageType">{{ capabilityMessage }}</div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { useLocalPreferencesAccess, type CapabilityCredentialInput } from '@/services/localPreferencesAccess'
import { inject, onActivated, onMounted, reactive, ref } from 'vue'
import { byokApi, preferencesApi } from '@/services/api'
import { pickByokCredential } from '@/utils/byokCredentials'
import AdminSelect from '@/components/AdminSelect.vue'
import Checkbox from '@/components/common/controls/Checkbox.vue'
import { usePreferencesStore } from '@/stores/preferences'
import { useI18n } from 'vue-i18n'

import { desktopProfileKey } from './desktopProfile'

const desktop = inject(desktopProfileKey, false)
const local = useLocalPreferencesAccess()?.capabilities?.()
const prefsStore = usePreferencesStore()
const { t } = useI18n()
const capabilityMessage = ref(''); const capabilityMessageType = ref('ok')
const testingCapability = ref<number | null>(null)
const serverDefault = '__server_default__'
const initialProvider = desktop ? '' : serverDefault
const modelProviders = [
  { value: 'tavily', labelKey: 'profileToolUi.tavily' },
  { value: 'baidu', labelKey: 'profileToolUi.baiduSearch' },
  { value: 'you', labelKey: 'profileToolUi.youCom' },
]
function providersFor(capability: string) {
  const providers = capability === 'similar_image_search'
    ? [{ value: 'qianfan', labelKey: 'profileToolUi.baiduQianfan' }]
    : modelProviders
  const options = providers.map(provider => ({ value: provider.value, label: t(provider.labelKey) }))
  if (!desktop) options.unshift({ value: serverDefault, label: t('profileToolUi.serverDefault') })
  return options
}
type CapabilityItem = Required<CapabilityCredentialInput> & { labelKey: string; hintKey: string; id: number | null; savedProvider?: string; saving: boolean }
const capabilityItems = reactive<CapabilityItem[]>([
  { capability: 'deep_research', labelKey: 'profileToolUi.deepResearch', hintKey: 'profileToolUi.deepResearchHint', provider: initialProvider, value: '', id: null, saving: false },
  { capability: 'similar_image_search', labelKey: 'profileToolUi.similarImageSearch', hintKey: 'profileToolUi.similarImageSearchHint', provider: initialProvider, value: '', id: null, saving: false },
])
const smtp = reactive({ host: '', port: 587, user: '', password: '', fromAddr: '', toAddr: '', useSsl: false, enabled: true, configured: false, saving: false, testing: false })
const smtpMessage = ref('')
const smtpMessageType = ref('ok')
async function loadCapabilities() {
  try {
    const rows = local ? await local.list() : (await byokApi.list()).items || []
    for (const item of capabilityItems) {
      const row = pickByokCredential(rows, item.capability)
      item.id = row?.id ?? null
      item.provider = row?.provider ?? initialProvider
      item.savedProvider = row?.provider
      item.value = ''
    }
  } catch (error) {
    if (local) {
      capabilityMessage.value = error instanceof Error ? error.message : t('profileToolUi.testFailed')
      capabilityMessageType.value = 'err'
    }
  }
}
if (local) onActivated(loadCapabilities)
else onMounted(loadCapabilities)
onMounted(async () => {
  void prefsStore.fetch()
  try {
    if (desktop) return
    const row = await preferencesApi.getSmtp()
    if (row) Object.assign(smtp, row, { password: '' })
  } catch {
    smtpMessage.value = t('profileToolUi.smtpSaveFailed')
    smtpMessageType.value = 'err'
  }
})
async function saveCapability(item: CapabilityItem) {
  if (!item.provider || (desktop && item.provider === serverDefault)) return
  if (item.provider === serverDefault) {
    if (!item.id) { capabilityMessage.value = t('profileToolUi.useServerDefault', { capability: t(item.labelKey) }); capabilityMessageType.value = 'ok'; return }
    item.saving = true
    capabilityMessage.value = ''
    try {
      await byokApi.remove(item.id)
      item.id = null
      item.savedProvider = undefined
      item.value = ''
      capabilityMessage.value = t('profileToolUi.switchedToServerDefault', { capability: t(item.labelKey) })
      capabilityMessageType.value = 'ok'
    } catch (e) {
      capabilityMessage.value = e instanceof Error ? e.message : t('profileToolUi.restoreDefaultFailed')
      capabilityMessageType.value = 'err'
    } finally { item.saving = false }
    return
  }
  item.saving = true
  capabilityMessage.value = ''
  try {
    const payload = { provider: item.provider, capability: item.capability, ...(item.value ? { value: item.value } : {}) }
    const webPayload = { ...payload, enabled: true }
    const row = local ? await local.save(payload, item.id)
      : item.id ? await byokApi.update(item.id, webPayload) : await byokApi.create(webPayload)
    item.id = row.id
    item.savedProvider = item.provider
    item.value = ''
    capabilityMessage.value = t('profileToolUi.savedCapability', { capability: t(item.labelKey) })
    capabilityMessageType.value = 'ok'
  } catch (e) {
    capabilityMessage.value = e instanceof Error ? e.message : t('profileToolUi.saveFailed')
    capabilityMessageType.value = 'err'
  } finally { item.saving = false }
}
async function testCapability(item: CapabilityItem) {
  if (!item.provider || item.provider === serverDefault || (!item.value && (!item.id || item.savedProvider !== item.provider))) return
  testingCapability.value = item.id ?? -1
  capabilityMessage.value = ''
  try {
    const payload = { provider: item.provider, capability: item.capability, value: item.value }
    const result = local ? await local.test(payload, item.id)
      : item.value ? await byokApi.testPreview(payload) : await byokApi.test(item.id!)
    capabilityMessage.value = result.message || t(result.ok ? 'profileToolUi.testPassed' : 'profileToolUi.testFailed')
    capabilityMessageType.value = result.ok ? 'ok' : 'err'
  } catch (e) {
    capabilityMessage.value = e instanceof Error ? e.message : t('profileToolUi.testFailed')
    capabilityMessageType.value = 'err'
  } finally { testingCapability.value = null }
}
function smtpInput() {
  return { host: smtp.host.trim(), port: Number(smtp.port), user: smtp.user.trim(),
    fromAddr: smtp.fromAddr.trim(), useSsl: smtp.useSsl, enabled: smtp.enabled,
    ...(smtp.password ? { password: smtp.password } : {}) }
}
async function saveSmtp() {
  smtp.saving = true
  smtpMessage.value = ''
  try {
    const input = smtpInput()
    await preferencesApi.saveSmtp(input)
    smtp.password = ''
    smtp.configured = true
    smtpMessage.value = t('profileToolUi.smtpSaved')
    smtpMessageType.value = 'ok'
  } catch {
    smtpMessage.value = t('profileToolUi.smtpSaveFailed')
    smtpMessageType.value = 'err'
  } finally { smtp.saving = false }
}
async function testSmtp() {
  if (!smtp.host || smtp.testing) return
  smtp.testing = true
  smtpMessage.value = ''
  try {
    const input = { ...smtpInput(), toAddr: smtp.toAddr.trim() || undefined }
    const result = await preferencesApi.testSmtp(input)
    smtpMessage.value = t(result.ok ? 'profileToolUi.smtpTestPassed' : 'profileToolUi.smtpTestFailed')
    smtpMessageType.value = result.ok ? 'ok' : 'err'
  } catch {
    smtpMessage.value = t('profileToolUi.smtpTestFailed')
    smtpMessageType.value = 'err'
  } finally { smtp.testing = false }
}
</script>

<style>
.capability-row .pm-field-desc { min-width: 0; flex: 1 1 auto; }
.capability-editor { display: flex; gap: var(--space-xs); align-items: center; flex: 0 1 auto; min-width: 0; flex-wrap: nowrap; justify-content: flex-end; }
.capability-editor .asel-wrap { flex: 0 0 130px; width: 130px; min-width: 0; }
.capability-editor .asel-trigger { width: 100%; min-width: 0 !important; padding-left: var(--space-sm); padding-right: var(--space-sm); }
.capability-editor .form-input { flex: 1 1 120px; width: 150px; min-width: 90px; height: 34px; box-sizing: border-box; }
.capability-editor .pm-style-chip { flex: 0 0 auto; white-space: nowrap; }
.smtp-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--space-sm); margin-top: var(--space-md); }
.smtp-grid .form-input { min-width: 0; height: 34px; box-sizing: border-box; }
.smtp-actions { display: flex; gap: var(--space-sm); justify-content: flex-start; margin-top: 0; }
.smtp-actions button:first-of-type { margin-left: auto; }
.smtp-enabled { margin-right: 0; color: var(--text-secondary); font-size: 12px; }
.smtp-ssl { color: var(--text-secondary); font-size: 12px; }
@media (max-width: 620px) {
  .smtp-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
