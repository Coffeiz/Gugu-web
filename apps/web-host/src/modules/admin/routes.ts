import { registerVoicePresetMutationRoutes } from './voice.js'
import { registerVoicePresetsReadRoute } from './voice.js'
import { registerAdminVoicePresetTestRoute, registerAdminVoiceTestRoute } from './voice.js'
import { registerAdminSearchTestRoute } from './search.js'
import { registerAdminMaintenanceStatusRoutes } from './runtime.js'
import { registerAccountMemoryCleanupRoutes } from './memory-cleanup.js'
import { registerAdminUpdateStatusRoute } from './runtime.js'
import { registerAdminUserDeleteRoute } from './users.js'
import { registerAgentCapabilityCatalogRoute } from './llm.js'
import { registerAgentStateLabelRoutes } from './llm-strategy.js'
import { createProviderCapabilityPreview } from '@gugu/core/byok/capabilities-preview'
import { registerServiceStatusRoute } from './runtime.js'
import { registerServiceRestartRoute } from './runtime.js'
import { registerStorageQuotaStatusRoute } from './storage.js'
import { registerNotificationBroadcastRoute, registerNotificationAdminHistoryRoutes } from '../notifications/admin.js'
import { registerEmailRecipientCountRoute } from './email.js'
import { registerAdminEmbeddingRebuildRoutes } from './embedding.js'
import { registerAdminIndexRebuildRoute } from './index-rebuild.js'
import { registerStorageLiveTotalsRoute } from './storage.js'
import { registerSafeEgressReadRoute } from './network.js'
import { registerImMemorySummaryRoutes } from './memory.js'
import { registerImMemoryMaintenanceApplyRoute } from './memory-apply.js'
import { registerImMemoryMaintenancePreviewRoute } from './memory-preview.js'
import { registerAdminUserBanRoute } from './users.js'
import { registerAdminEmailPreviewRoute } from './email.js'
import { registerSmtpProbeRoute } from './smtp.js'
import { registerAdminEmailTestRoute } from './email.js'
import { registerAdminEmailPublishRoute } from './email.js'
import { registerAdminEmailTranslateRoute } from './email.js'
import { registerAdminPromptRoutes } from './prompts.js'
import { registerLlmStrategyRoute } from './llm-strategy.js'
import { registerLlmPresetSelectionRoutes } from './llm.js'
import { registerLlmCapabilityOverrideRoute } from './llm-probe.js'
import { registerLlmPresetMutationRoutes } from './llm-settings.js'
import { registerModelDirectoryRoutes } from './llm.js'
import { registerAdminRecentMisreadRoute } from './perception.js'
import { registerAdminPerceptionExportRoute } from './perception.js'
import { registerAdminMisreadExportRoute } from './perception.js'
import { registerAdminPerceptionStatsRoute } from './perception.js'
import { registerAdminOpsSummaryRoute } from './runtime.js'
import { registerEmbeddingProbeRoute } from './embedding-probe.js'
import { registerAdminMediaProbePreviewRoute } from './llm-probe.js'
import { registerAdminLlmPresetTestRoute } from './llm-probe.js'
import { registerAdminLlmPresetMediaProbeRoute } from './llm-probe.js'
import { registerAdminLlmPresetReadRoute } from './llm.js'
import { registerAdminLlmCapabilityProbeRoute } from './llm-probe.js'
import { registerAdminLlmCapabilityPreviewRoute } from './llm-probe.js'
import { registerAdminEmbeddingRebuildStatusRoute } from './embedding.js'
import { registerSafeEgressUpdateRoute } from './network-update.js'
import { registerSafeEgressProbeRoute } from './network.js'
import { registerSandboxEgressRoutes } from './sandbox.js'
import { registerSandboxStatusRoute } from './sandbox.js'
import { registerSandboxEnableRoute } from './sandbox.js'
import { registerSandboxDisableRoute } from './sandbox.js'
import { registerSystemLogRoutes } from './logs.js'
import { registerAdminAnalyticsRoutes } from './analytics.js'
import { registerAdminAuditLogRoute } from './audit.js'
import { registerAdminUserSettingsRoutes } from './users.js'
import { type FastifyInstance } from 'fastify'
import { registerAdminFeedbackRoute } from '../feedback/feedback.js'
import { registerAdminUsersRoute, registerAdminUserRiskRoute } from './users.js'
import { registerAdminUserStatusRoutes } from './users.js'
import { registerAdminDebugLogRoutes } from './logs.js'
import { registerAdminStorageSnapshotsRoute } from './storage.js'
import { registerAdminSecurityEventRoutes } from './audit.js'
import { registerAdminUserSecurityEventRoute } from './users.js'
import { registerAdminAgentUsageRoute } from './usage.js'
import { registerAdminConfigRoutes } from './config.js'
import { registerSandboxNetworkRoutes } from './sandbox-network.js'
import { registerAdminLlmPresetRoutes } from './llm.js'
import type { WebUiOptions } from '../../http/options.js'

export function registerAdminRoutes(app: FastifyInstance, options: WebUiOptions) {
  options.adminAuth?.registerRoutes(app)
  if (options.adminAuth && options.adminConfig) {
    registerAdminConfigRoutes(app, {
      ...options.adminConfig,
      requireAdmin: options.adminAuth.requireAdmin,
    })
    registerSandboxNetworkRoutes(app, { ...options.adminConfig, requireAdmin: options.adminAuth.requireAdmin })
  }
  if (options.adminAuth && options.adminVoiceTest) {
    registerAdminVoiceTestRoute(app, { ...options.adminVoiceTest, requireAdmin: options.adminAuth.requireAdmin })
  }
  if (options.adminAuth && options.adminVoicePresetTest) {
    registerAdminVoicePresetTestRoute(app, { ...options.adminVoicePresetTest, requireAdmin: options.adminAuth.requireAdmin })
  }
  if (options.adminAuth && options.adminSearchTest) {
    registerAdminSearchTestRoute(app, { ...options.adminSearchTest, requireAdmin: options.adminAuth.requireAdmin })
  }
  if (options.adminAuth && options.adminLlmPresets) {
    registerAdminLlmPresetRoutes(app, { ...options.adminLlmPresets, requireAdmin: options.adminAuth.requireAdmin })
  }
  if (options.adminAuth && options.adminLlmPresetList) {
    registerAdminLlmPresetReadRoute(app, { ...options.adminLlmPresetList, requireAdmin: options.adminAuth.requireAdmin })
  }
  if (options.adminAuth && options.adminStorageSnapshots) {
    registerAdminStorageSnapshotsRoute(app, {
      ...options.adminStorageSnapshots,
      requireAdmin: options.adminAuth.requireAdmin,
    })
  }
  if (options.adminAuth && options.adminUsers) {
    registerAdminUsersRoute(app, {
      ...options.adminUsers,
      requireAdmin: options.adminAuth.requireAdmin,
    })
  }
  if (options.adminAuth && options.adminUserStatus) {
    registerAdminUserStatusRoutes(app, {
      ...options.adminUserStatus,
      requireAdmin: options.adminAuth.requireAdmin,
    })
  }
  if (options.adminAuth && options.adminDebugLogs) {
    registerAdminDebugLogRoutes(app, {
      ...options.adminDebugLogs,
      requireAdmin: options.adminAuth.requireAdmin,
      verifyAdmin: options.adminAuth.verifyAdmin,
    })
  }
  if (options.adminAuth && options.adminSecurityEvents) {
    registerAdminSecurityEventRoutes(app, {
      ...options.adminSecurityEvents,
      requireAdmin: options.adminAuth.requireAdmin,
    })
  }
  if (options.adminAuth && options.adminFeedback) {
    registerAdminFeedbackRoute(app, options.adminAuth.requireAdmin, options.adminFeedback)
  }
  if (options.adminAuth && options.adminUserSecurityEvents) {
    registerAdminUserSecurityEventRoute(app, {
      ...options.adminUserSecurityEvents,
      requireAdmin: options.adminAuth.requireAdmin,
    })
  }
  if (options.adminAuth && options.adminUserRisk) {
    registerAdminUserRiskRoute(app, {
      ...options.adminUserRisk,
      requireAdmin: options.adminAuth.requireAdmin,
    })
  }
  if (options.adminAuth && options.adminAgentUsage) {
    registerAdminAgentUsageRoute(app, {
      ...options.adminAgentUsage,
      requireAdmin: options.adminAuth.requireAdmin,
    })
  }
  if (options.adminAuth && options.emailRecipientCount) registerEmailRecipientCountRoute(app, { ...options.emailRecipientCount, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.storageQuotaStatus) registerStorageQuotaStatusRoute(app, { ...options.storageQuotaStatus, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.serviceStatus) registerServiceStatusRoute(app, { ...options.serviceStatus, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.serviceRestart) registerServiceRestartRoute(app, { ...options.serviceRestart, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminMaintenanceStatus) registerAdminMaintenanceStatusRoutes(app, {
    ...options.adminMaintenanceStatus, requireAdmin: options.adminAuth.requireAdmin,
    readAccountMemoryCleanup: options.accountMemoryCleanup?.status,
  })
  if (options.adminAuth && options.accountMemoryCleanup) registerAccountMemoryCleanupRoutes(app, {
    requireAdmin: options.adminAuth.requireAdmin, runtime: options.accountMemoryCleanup,
  })
  if (options.adminAuth && options.adminUpdateMode) registerAdminUpdateStatusRoute(app, { mode: options.adminUpdateMode, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.storageLiveTotals) registerStorageLiveTotalsRoute(app, { ...options.storageLiveTotals, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.safeEgressRead) registerSafeEgressReadRoute(app, { ...options.safeEgressRead, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.imMemorySummary) registerImMemorySummaryRoutes(app, { ...options.imMemorySummary, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.imMemoryMaintenancePreview) registerImMemoryMaintenancePreviewRoute(app, { ...options.imMemoryMaintenancePreview, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.imMemoryMaintenanceApply) registerImMemoryMaintenanceApplyRoute(app, { ...options.imMemoryMaintenanceApply, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminUserBan) registerAdminUserBanRoute(app, { ...options.adminUserBan, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminEmailPreview) registerAdminEmailPreviewRoute(app, { ...options.adminEmailPreview, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.smtpProbe) registerSmtpProbeRoute(app, { ...options.smtpProbe, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminEmailTest) registerAdminEmailTestRoute(app, { ...options.adminEmailTest, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminEmailPublish) registerAdminEmailPublishRoute(app, { operations: options.adminEmailPublish, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminEmailTranslate) registerAdminEmailTranslateRoute(app, { ...options.adminEmailTranslate, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminPrompts) registerAdminPromptRoutes(app, { ...options.adminPrompts, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.llmStrategy) registerLlmStrategyRoute(app, { ...options.llmStrategy, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.llmPresetSelection) registerLlmPresetSelectionRoutes(app, { ...options.llmPresetSelection, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.llmCapabilityOverrides) registerLlmCapabilityOverrideRoute(app, { ...options.llmCapabilityOverrides, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.llmPresetMutations) registerLlmPresetMutationRoutes(app, { ...options.llmPresetMutations, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.modelDirectory) registerModelDirectoryRoutes(app, { ...options.modelDirectory, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminRecentMisread) registerAdminRecentMisreadRoute(app, { ...options.adminRecentMisread, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminPerceptionExport) registerAdminPerceptionExportRoute(app, { ...options.adminPerceptionExport, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminMisreadExport) registerAdminMisreadExportRoute(app, { ...options.adminMisreadExport, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminPerceptionStats) registerAdminPerceptionStatsRoute(app, { ...options.adminPerceptionStats, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminOpsSummary) registerAdminOpsSummaryRoute(app, { ...options.adminOpsSummary, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminEmbeddingProbe) registerEmbeddingProbeRoute(app, { ...options.adminEmbeddingProbe, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminMediaProbePreview) registerAdminMediaProbePreviewRoute(app, { ...options.adminMediaProbePreview, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminLlmPresetTest) registerAdminLlmPresetTestRoute(app, { ...options.adminLlmPresetTest, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminLlmPresetMediaProbe) registerAdminLlmPresetMediaProbeRoute(app, { ...options.adminLlmPresetMediaProbe, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminLlmCapabilityProbe) registerAdminLlmCapabilityProbeRoute(app, { ...options.adminLlmCapabilityProbe, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth) registerAdminLlmCapabilityPreviewRoute(app, {
    requireAdmin: options.adminAuth.requireAdmin,
    preview: createProviderCapabilityPreview(() => true),
  })
  if (options.adminAuth && options.adminEmbeddingRebuildStatus) registerAdminEmbeddingRebuildStatusRoute(app, { ...options.adminEmbeddingRebuildStatus, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminEmbeddingRebuild) registerAdminEmbeddingRebuildRoutes(app, { ...options.adminEmbeddingRebuild, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminIndexRebuild) registerAdminIndexRebuildRoute(app, { ...options.adminIndexRebuild, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.safeEgressUpdate) registerSafeEgressUpdateRoute(app, { ...options.safeEgressUpdate, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.safeEgressProbe) registerSafeEgressProbeRoute(app, { ...options.safeEgressProbe, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.sandboxEgress) registerSandboxEgressRoutes(app, { ...options.sandboxEgress, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.sandboxStatus) registerSandboxStatusRoute(app, { ...options.sandboxStatus, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.sandboxEnable) registerSandboxEnableRoute(app, { ...options.sandboxEnable, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.sandboxDisable) registerSandboxDisableRoute(app, { ...options.sandboxDisable, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.voicePresetsMutate) registerVoicePresetMutationRoutes(app, { ...options.voicePresetsMutate, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.voicePresetsRead) registerVoicePresetsReadRoute(app, { ...options.voicePresetsRead, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminSystemLogs) registerSystemLogRoutes(app, { ...options.adminSystemLogs, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminAnalytics) registerAdminAnalyticsRoutes(app, { ...options.adminAnalytics, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminAuditLog) registerAdminAuditLogRoute(app, { ...options.adminAuditLog, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminUserSettings) registerAdminUserSettingsRoutes(app, { ...options.adminUserSettings, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.adminUserDelete) registerAdminUserDeleteRoute(app, {
    ...options.adminUserDelete,
    requireAdmin: options.adminAuth.requireAdmin,
  })
  if (options.adminAuth && options.adminAgentCapabilities) registerAgentCapabilityCatalogRoute(app, {
    ...options.adminAgentCapabilities,
    requireAdmin: options.adminAuth.requireAdmin,
  })
  if (options.adminAuth && options.adminAgentStateLabels) registerAgentStateLabelRoutes(app, {
    ...options.adminAgentStateLabels,
    requireAdmin: options.adminAuth.requireAdmin,
  })
  if (options.adminAuth && options.notificationBroadcast) registerNotificationBroadcastRoute(app, { ...options.notificationBroadcast, requireAdmin: options.adminAuth.requireAdmin })
  if (options.adminAuth && options.notificationAdminHistory) registerNotificationAdminHistoryRoutes(app, { ...options.notificationAdminHistory, requireAdmin: options.adminAuth.requireAdmin })
}
