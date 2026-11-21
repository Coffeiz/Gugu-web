<script setup lang="ts">
import DesktopLogs from './DesktopLogs.vue'
import DesktopAuxiliaryModels from './DesktopAuxiliaryModels.vue'
import ProfileModal from '@/components/common/profile/ProfileModal.vue'
import { hasDesktopAgentModelBridge, hasDesktopAuxiliaryModelBridge, requestDesktopAgentModel } from './agent-model-transport'
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { hasDesktopTelegramGateway, requestDesktopTelegram, type DesktopTelegramSnapshot } from '@desktop/bridge/bridge'
import DesktopTelegramGateway from '../im/connect/platforms/telegram/DesktopTelegramGateway.vue'
import DesktopAgentModel from './DesktopAgentModel.vue'
import DesktopWorkspaceSettings from './DesktopWorkspaceSettings.vue'
import RemoteAccountPane from './index.vue'
import { desktopImSettingsAdapter } from '../im/connect/adapter'

defineProps<{ show: boolean; connected: boolean; initialNav: 'info' | 'prefs'; refreshImportedData?: () => void }>()
defineEmits<{ close: [] }>()

const { t } = useI18n()
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
    <template #local-status>
      <div class="pm-sep"></div>
      <section class="pm-section">
        <h3 class="pm-section-label">本地服务</h3>
        <p class="pm-field-hint" role="status">{{ connected ? 'Core 已连接，数据保存在当前设备。' : '正在连接本地服务。' }}</p>
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
    <template #desktop-workspaces><DesktopWorkspaceSettings /></template>
    <template #desktop-logs><DesktopLogs /></template>
    <template #remote><RemoteAccountPane /></template>
  </ProfileModal>
</template>
