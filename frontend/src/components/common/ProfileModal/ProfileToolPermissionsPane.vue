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
    <div class="pm-sep"></div>
    <div class="pm-section">
      <div class="pm-section-label">{{ t('profileToolUi.capabilityCredentials') }}</div>
      <p class="pm-field-hint">{{ t('profileToolUi.capabilityHint') }}</p>
      <div v-for="item in capabilityItems" :key="item.capability" class="pm-field-row capability-row">
        <div class="pm-field-desc"><span class="pm-field-name">{{ t(item.labelKey) }}</span><span class="pm-field-hint">{{ t(item.hintKey) }}</span></div>
        <div class="capability-editor"><AdminSelect v-model="item.provider" :options="providersFor(item.capability)" :placeholder="t('profileToolUi.selectProvider')" /><input v-model="item.value" class="form-input" type="password" autocomplete="new-password" :placeholder="t('profileToolUi.keepKeyPlaceholder')" /><button class="pm-style-chip" :disabled="item.saving || !item.provider || item.provider === serverDefault || (testingCapability !== null && testingCapability === item.id)" :title="item.provider === serverDefault ? t('profileToolUi.defaultCannotTest') : t('profileToolUi.testCurrent')" @click="testCapability(item)">{{ testingCapability === (item.id ?? -1) ? t('profileToolUi.testing') : t('common.actions.test') }}</button><button class="pm-style-chip" :disabled="item.saving" @click="saveCapability(item)">{{ item.saving ? t('sharedUi.saving') : item.id ? t('common.actions.update') : t('sharedUi.save') }}</button></div>
      </div>
      <div v-if="capabilityMessage" class="pm-msg" :class="capabilityMessageType">{{ capabilityMessage }}</div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { byokApi } from '@/services/api'
import { pickByokCredential } from '@/utils/byokCredentials'
import AdminSelect from '@/components/AdminSelect.vue'
import { usePreferencesStore } from '@/stores/preferences'
import { useI18n } from 'vue-i18n'

const prefsStore = usePreferencesStore()
const { t } = useI18n()
const capabilityMessage = ref(''); const capabilityMessageType = ref('ok')
const testingCapability = ref<number | null>(null)
const serverDefault = '__server_default__'
const modelProviders = [
  { value: 'tavily', labelKey: 'profileToolUi.tavily' },
  { value: 'baidu', labelKey: 'profileToolUi.baiduSearch' },
  { value: 'you', labelKey: 'profileToolUi.youCom' },
]
function providersFor(capability: string) {
  const providers = capability === 'similar_image_search'
    ? [{ value: 'qianfan', labelKey: 'profileToolUi.baiduQianfan' }]
    : modelProviders
  return [{ value: serverDefault, label: t('profileToolUi.serverDefault') }, ...providers.map(provider => ({ value: provider.value, label: t(provider.labelKey) }))]
}
const capabilityItems = reactive<any[]>([
  { capability: 'deep_research', labelKey: 'profileToolUi.deepResearch', hintKey: 'profileToolUi.deepResearchHint', provider: serverDefault, value: '', id: null, saving: false },
  { capability: 'similar_image_search', labelKey: 'profileToolUi.similarImageSearch', hintKey: 'profileToolUi.similarImageSearchHint', provider: serverDefault, value: '', id: null, saving: false },
])
onMounted(async () => { try { const rows = (await byokApi.list()).items || []; for (const item of capabilityItems) { const row = pickByokCredential(rows, item.capability); if (row) { item.id = row.id; item.provider = row.provider } } } catch { /* BYOK 关闭时仍正常显示专项能力 */ } })
async function saveCapability(item: any) {
  if (item.provider === serverDefault) {
    if (!item.id) { capabilityMessage.value = t('profileToolUi.useServerDefault', { capability: t(item.labelKey) }); capabilityMessageType.value = 'ok'; return }
    item.saving = true
    capabilityMessage.value = ''
    try {
      await byokApi.remove(item.id)
      item.id = null
      item.value = ''
      capabilityMessage.value = t('profileToolUi.switchedToServerDefault', { capability: t(item.labelKey) })
      capabilityMessageType.value = 'ok'
    } catch (e) {
      capabilityMessage.value = e instanceof Error ? e.message : t('profileToolUi.restoreDefaultFailed')
      capabilityMessageType.value = 'err'
    } finally { item.saving = false }
    return
  }
  item.saving = true; capabilityMessage.value = ''; try { const payload: Record<string, unknown> = { provider: item.provider, capability: item.capability, enabled: true }; if (item.value) payload.value = item.value; const row = item.id ? await byokApi.update(item.id, payload) : await byokApi.create(payload); item.id = row.id; item.value = ''; capabilityMessage.value = t('profileToolUi.savedCapability', { capability: t(item.labelKey) }); capabilityMessageType.value = 'ok' } catch (e) { capabilityMessage.value = e instanceof Error ? e.message : t('profileToolUi.saveFailed'); capabilityMessageType.value = 'err' } finally { item.saving = false }
}
async function testCapability(item: any) { if (!item.provider || item.provider === serverDefault || (!item.id && !item.value)) return; const marker = item.id ?? -1; testingCapability.value = marker; capabilityMessage.value = ''; try { const result = item.value ? await byokApi.testPreview({ provider: item.provider, capability: item.capability, value: item.value }) : await byokApi.test(item.id); capabilityMessage.value = result.message || t('profileToolUi.testPassed'); capabilityMessageType.value = result.ok ? 'ok' : 'err' } catch (e) { capabilityMessage.value = e instanceof Error ? e.message : t('profileToolUi.testFailed'); capabilityMessageType.value = 'err' } finally { testingCapability.value = null } }
</script>

<style>
.capability-row .pm-field-desc { min-width: 0; flex: 1 1 auto; }
.capability-editor { display: flex; gap: 6px; align-items: center; flex: 0 1 auto; min-width: 0; flex-wrap: nowrap; justify-content: flex-end; }
.capability-editor .asel-wrap { flex: 0 0 130px; width: 130px; min-width: 0; }
.capability-editor .asel-trigger { width: 100%; min-width: 0 !important; padding-left: 8px; padding-right: 8px; }
.capability-editor .form-input { flex: 1 1 120px; width: 150px; min-width: 90px; height: 34px; box-sizing: border-box; }
.capability-editor .pm-style-chip { flex: 0 0 auto; white-space: nowrap; }
</style>
