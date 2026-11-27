<script setup lang="ts">
import DesktopLogs from './DesktopLogs.vue'
import DesktopUpdatePane from './DesktopUpdatePane.vue'
import DesktopAuxiliaryModels from './DesktopAuxiliaryModels.vue'
import ProfileModal from '@/components/common/profile/ProfileModal.vue'
import ProfileDevicePane from '@/components/common/profile/ProfileDevicePane.vue'
import { hasDesktopAgentModelBridge, hasDesktopAuxiliaryModelBridge, requestDesktopAgentModel } from './agent-model-transport'
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { callDesktopBridge, hasDesktopTelegramGateway, requestDesktopTelegram, type DesktopTelegramSnapshot } from '@desktop/bridge/bridge'
import DesktopTelegramGateway from '../im/connect/platforms/telegram/DesktopTelegramGateway.vue'
import DesktopAgentModel from './DesktopAgentModel.vue'
import DesktopFileOpenSettings from './DesktopFileOpenSettings.vue'
import DesktopWorkspaceSettings from './DesktopWorkspaceSettings.vue'
import RemoteAccountPane from './index.vue'
import { desktopImSettingsAdapter } from '../im/connect/adapter'

defineProps<{ show: boolean; connected: boolean; initialNav: 'info' | 'prefs'; refreshImportedData?: () => void }>()
defineEmits<{ close: [] }>()

const { t } = useI18n()
const loadDesktopDevice = () => callDesktopBridge(bridge => bridge.deviceInfo())
const missingModel = ref(false)
const telegramSnapshot = ref<DesktopTelegramSnapshot>()
const connectTelegram = hasDesktopTelegramGateway() ? async (token: string) => {
  telegramSnapshot.value = await requestDesktopTelegram({ action: 'save', input: { token } })
} : undefined

onMounted(async () => {
  if (!hasDesktopAgentModelBridge()) return
  try { missingModel.value = (await requestDesktopAgentModel({ action: 'get' })) === null }
  catch { /* 只在明确未配置时显示提示。 */ }
})
</script>

<template>
  <ProfileModal desktop :desktop-im-adapter="desktopImSettingsAdapter" :connect-telegram="connectTelegram" :show="show" :initial-nav="initialNav" @close="$emit('close')" :refresh-imported-data="refreshImportedData">
    <template #device-info><ProfileDevicePane :load-desktop-device="loadDesktopDevice" /></template>
    <template #local-status>
      <DesktopUpdatePane />
      <div class="pm-sep"></div>
      <section class="pm-section">
        <h3 class="pm-section-label">{{ $t('pageUi.localService') }}</h3>
        <p class="pm-field-hint" role="status">{{ connected ? $t('pageUi.coreConnectedHint') : $t('pageUi.coreConnecting') }}</p>
      </section>
    </template>
    <template #telegram-status="{ setConfigured }">
      <DesktopTelegramGateway :saved-snapshot="telegramSnapshot" @configured="setConfigured" />
    </template>
    <template #im-notice>
      <p v-if="missingModel" class="pm-field-hint" role="status">{{ t('profileImUi.desktopMissingModel') }}</p>
    </template>
    <template #desktop-model>
      <DesktopAgentModel />
      <div v-if="hasDesktopAgentModelBridge() && hasDesktopAuxiliaryModelBridge()" class="pm-sep" aria-hidden="true"></div>
      <DesktopAuxiliaryModels />
    </template>
    <template #desktop-file-settings><DesktopFileOpenSettings /></template>
    <template #desktop-workspaces><DesktopWorkspaceSettings /></template>
    <template #desktop-logs><DesktopLogs /></template>
    <template #remote><RemoteAccountPane /></template>
  </ProfileModal>
</template>
