import { applyLocalePatches } from './sections/common'
import { zhCN } from './locales/zh-CN'
import { jaJP } from './locales/ja-JP'
import { enUS } from './locales/en-US'
import { terminalUi } from './sections/terminal'
import { filesUi, filesViewUi } from './sections/files'
import { calendarUi } from './sections/calendar'
import { mindUi, mindEditorUi } from './sections/mind'
import { scheduleUi } from './sections/schedules'
import { adminLlmUi } from './sections/adminLlm'
import { personalityUi } from './sections/personality'
import { adminAnalyticsUi } from './sections/adminAnalytics'
import { adminStorageUi } from './sections/adminStorage'
import { adminRuntimeUi } from './sections/adminRuntime'
import { adminUsageUi } from './sections/adminUsage'
import { profileGuguUi } from './sections/profileGugu'
import { chatToolLabels, chatUi } from './sections/chat'
import { perceptionUi } from './sections/perception'
import { memorySettingsUi, memoryMaintenanceUi } from './sections/memorySettings'
import { configUi, configExtraUi } from './sections/config'
import { adminExtraUi } from './sections/adminExtra'

export const messages = {
  'zh-CN': { ...zhCN, terminalUi: terminalUi['zh-CN'], filesUi: filesUi['zh-CN'], filesViewUi: filesViewUi['zh-CN'], profileGuguUi: profileGuguUi['zh-CN'], chatUi: chatUi['zh-CN'], perceptionUi: perceptionUi['zh-CN'], mindEditorUi: mindEditorUi['zh-CN'], memorySettingsUi: memorySettingsUi['zh-CN'], memoryMaintenanceUi: memoryMaintenanceUi['zh-CN'], calendarUi: calendarUi['zh-CN'], mindUi: mindUi['zh-CN'], scheduleUi: scheduleUi['zh-CN'], adminLlmUi: adminLlmUi['zh-CN'], personalityUi: personalityUi['zh-CN'], adminAnalyticsUi: adminAnalyticsUi['zh-CN'], adminStorageUi: adminStorageUi['zh-CN'], adminRuntimeUi: adminRuntimeUi['zh-CN'], adminUsageUi: adminUsageUi['zh-CN'], adminAgentUi: {}, agentConfigUi: {}, configUi: { ...configUi['zh-CN'], ...configExtraUi['zh-CN'] }, adminExtraUi: adminExtraUi['zh-CN'] },
  'ja-JP': { ...jaJP, terminalUi: terminalUi['ja-JP'], filesUi: filesUi['ja-JP'], filesViewUi: filesViewUi['ja-JP'], profileGuguUi: profileGuguUi['ja-JP'], chatUi: chatUi['ja-JP'], perceptionUi: perceptionUi['ja-JP'], mindEditorUi: mindEditorUi['ja-JP'], memorySettingsUi: memorySettingsUi['ja-JP'], memoryMaintenanceUi: memoryMaintenanceUi['ja-JP'], calendarUi: calendarUi['ja-JP'], mindUi: mindUi['ja-JP'], scheduleUi: scheduleUi['ja-JP'], adminLlmUi: adminLlmUi['ja-JP'], personalityUi: personalityUi['ja-JP'], adminAnalyticsUi: adminAnalyticsUi['ja-JP'], adminStorageUi: adminStorageUi['ja-JP'], adminRuntimeUi: adminRuntimeUi['ja-JP'], adminUsageUi: adminUsageUi['ja-JP'], adminAgentUi: {}, agentConfigUi: {}, configUi: { ...configUi['ja-JP'], ...configExtraUi['ja-JP'] }, adminExtraUi: adminExtraUi['ja-JP'] },
  'en-US': { ...enUS, terminalUi: terminalUi['en-US'], filesUi: filesUi['en-US'], filesViewUi: filesViewUi['en-US'], profileGuguUi: profileGuguUi['en-US'], chatUi: chatUi['en-US'], perceptionUi: perceptionUi['en-US'], mindEditorUi: mindEditorUi['en-US'], memorySettingsUi: memorySettingsUi['en-US'], memoryMaintenanceUi: memoryMaintenanceUi['en-US'], calendarUi: calendarUi['en-US'], mindUi: mindUi['en-US'], scheduleUi: scheduleUi['en-US'], adminLlmUi: adminLlmUi['en-US'], personalityUi: personalityUi['en-US'], adminAnalyticsUi: adminAnalyticsUi['en-US'], adminStorageUi: adminStorageUi['en-US'], adminRuntimeUi: adminRuntimeUi['en-US'], adminUsageUi: adminUsageUi['en-US'], adminAgentUi: {}, agentConfigUi: {}, configUi: { ...configUi['en-US'], ...configExtraUi['en-US'] }, adminExtraUi: adminExtraUi['en-US'] },
}
applyLocalePatches(messages)
export type MessageSchema = typeof zhCN
