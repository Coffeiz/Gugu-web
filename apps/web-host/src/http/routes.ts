import { registerSecretPromptCancelRoute } from '../modules/agent/interactions/secret-cancel.js'
import {
  registerUserBotCreateRoute,
  registerUserBotDeleteRoute,
  registerUserBotUpdateRoute,
  registerUserBotsListRoute,
} from '../modules/im/routes.js'
import { registerQqConnectRoutes } from '../modules/im/connect/platforms/qq/index.js'
import { registerFeishuConnectRoutes } from '../modules/im/connect/platforms/feishu/index.js'
import { registerWechatConnectRoutes } from '../modules/im/connect/platforms/wechat/index.js'
import { registerTelegramConnectRoutes } from '../modules/im/connect/platforms/telegram/index.js'
import { registerDataExportDownloadRoutes } from '../modules/data-portability/download.js'
import { registerTaskFilesystemAuthorizationRoutes, registerTaskFilesystemRevokeRoute } from '../modules/scheduled-tasks/access.js'
import { registerAccountDeleteRoute } from '../modules/auth/account/delete.js'
import { registerVoiceAvailabilityRoute } from '../modules/agent/voice.js'
import { registerMemoryClearRoute } from '../modules/agent/memory.js'
import { registerUserBotBindingCodeRoutes } from '../modules/im/connect/code.js'
import { registerLoopScopeProxyRoutes } from '../modules/loopscope/proxy.js'
import { registerAttentionDefaultsRoute } from '../modules/im/settings.js'
import { registerEmbeddingRebuildStatusRoute } from '../modules/agent/memory/rebuild.js'
import { registerEmbeddingRebuildRoute } from '../modules/agent/memory/rebuild.js'
import { registerUserBotUnbindRoute } from '../modules/im/connect/unbind.js'
import { registerUserSkillDeleteRoute, registerUserSkillListRoute, registerUserSkillWriteRoutes } from '../modules/skills/routes.js'
import { registerOnboardingResetGuideRoute, registerOnboardingRoutes, registerOnboardingReseedRoute } from '../modules/onboarding/routes.js'
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { requestContext } from '@gugu/core'
import { registerSessionLogout, registerSessionRoutes } from '../modules/auth/session/routes.js'
import { registerRegistrationRoutes } from '../modules/auth/registration/routes.js'
import { registerPreferencesRoutes } from '../modules/preferences/preferences.js'
import { registerProfileRoute } from '../modules/auth/account/profile.js'
import { registerPasswordResetRoutes } from '../modules/auth/password-reset.js'
import { registerEmailChangeUserRoutes, registerEmailChangeVerifyRoute } from '../modules/auth/email-change.js'
import { registerUserQuotaRoute } from '../modules/auth/quota/routes.js'
import { registerLiveRoutes } from '../modules/live/live.js'
import { registerUserAvatarReadRoute, registerUserAvatarUploadRoute } from '../modules/auth/account/avatar.js'
import { registerProjectRoutes } from '../modules/projects/routes.js'
import { registerClientRoutes } from '../modules/clients/routes.js'
import { registerEventRoutes } from '../modules/calendar/routes.js'
import { registerMindRoutes } from '../modules/mind/routes.js'
import { registerUndoRoutes } from '../modules/undo/routes.js'
import {
  registerScheduledTaskDelete,
  registerScheduledTaskList,
  registerScheduledTaskTestNotify,
  registerScheduledTaskWrites,
  registerScheduledTaskRunNow,
} from '../modules/scheduled-tasks/routes.js'
import { registerScheduledTaskDeliveryTargets } from '../modules/scheduled-tasks/delivery/targets.js'
import { registerNotificationRoutes } from '../modules/notifications/routes.js'
import { registerTrackRoute } from '../modules/site/routes.js'
import { registerFeedbackRoute } from '../modules/feedback/feedback.js'
import { registerWorkspaceRoutes, registerWorkspaceDirectoryRoutes } from '../modules/workspaces/routes.js'
import type { WebUiOptions } from './options.js'
import { registerProtectedDomain } from './user.js'
import { registerPortabilityRoutes } from '../modules/data-portability/routes.js'
import { registerMcpRoutes } from '../modules/mcp/routes.js'
import { registerAttachmentRoutes } from '../modules/agent/attachments/routes.js'
import { registerTerminalRoutes } from '../modules/terminals/routes.js'
import { registerMailRoutes } from '../modules/mail/routes.js'
import { registerByokRoutes } from '../modules/byok/routes.js'
import { registerDesktopAgentDeepResearchRoute, registerDesktopAgentSimilarImageRoute } from '../modules/agent/tools/desktop-search-route.js'
import { registerAgentRoutes } from '../modules/agent/routes.js'
import { registerFileRoutes } from '../modules/files/routes.js'

export function registerUserRoutes(app: FastifyInstance, options: WebUiOptions) {
  const auth = options.userAuth
  if (options.userAvatar) registerUserAvatarReadRoute(app, options.userAvatar)
  registerRegistrationRoutes(app, options)
  if (options.passwordReset) registerPasswordResetRoutes(app, options.passwordReset)
  else {
    const unavailable = async (_request: FastifyRequest, reply: FastifyReply) =>
      reply.code(503).send({ detail: '密码找回邮件当前不可用' })
    app.post('/api/v1/auth/forgot-password', unavailable)
    app.post('/api/v1/auth/reset-password', async (_request, reply) =>
      reply.code(503).send({ detail: '密码重置服务暂不可用' }),
    )
  }
  if (options.emailChange) registerEmailChangeVerifyRoute(app, options.emailChange)
  if (!auth) return
  registerSessionRoutes(app, auth)
  if (options.live) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerLiveRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        securityVersionFromRequest: (request) => userFromRequest(request).requestContext.identity.securityVersion,
        operations: options.live!,
      })
    })
  }
  if (options.emailChange) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerEmailChangeUserRoutes(routes, {
        ...options.emailChange!,
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
      })
    })
  }
  if (options.userAvatar) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerUserAvatarUploadRoute(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.userAvatar!,
      })
    })
  }
  if (auth.getQuota) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerUserQuotaRoute(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        get: auth.getQuota!,
      })
    })
  }
  registerSessionLogout(app, auth, options.webPush?.remove)
  if (options.webPush)
    registerProtectedDomain(app, auth, (routes, userFromRequest) => options.webPush!.register(routes, userFromRequest))
  if (options.profile) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerProfileRoute(routes, {
        ...options.profile!,
        authenticate: async (request) => ({ id: userFromRequest(request).id }),
      })
    })
  }
  if (options.preferences) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerPreferencesRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        userEmailFromRequest: (request) => userFromRequest(request).email,
        store: options.preferences!,
        emailChangeAvailable: options.emailChange?.systemEmailAvailable ?? false,
      })
    })
  }
  if (options.dataExportDownload) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerDataExportDownloadRoutes(routes, userFromRequest, options.dataExportDownload!))
  }
  if (options.secretPromptCancel && !options.agentSecretInteraction) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerSecretPromptCancelRoute(routes, {
      ...options.secretPromptCancel!, requireUser: async (request) => { void userFromRequest(request) },
      ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  registerPortabilityRoutes(app, auth, options)
  if (options.userBotBindingCode) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerUserBotBindingCodeRoutes(routes, { ...options.userBotBindingCode!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId }))
  }
  if (options.wechatConnect) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerWechatConnectRoutes(routes, {
      ...options.wechatConnect!, requireUser: async (request) => { void userFromRequest(request) },
      ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.feishuConnect) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerFeishuConnectRoutes(routes, {
      ...options.feishuConnect!, requireUser: async (request) => { void userFromRequest(request) },
      ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.qqConnect) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerQqConnectRoutes(routes, {
      ...options.qqConnect!, requireUser: async (request) => { void userFromRequest(request) },
      ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.telegramConnect) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerTelegramConnectRoutes(routes, {
      ...options.telegramConnect!, requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.userBotUpdate) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerUserBotUpdateRoute(routes, {
      ...options.userBotUpdate!, requireUser: async (request) => { void userFromRequest(request) },
      ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.userBotDelete) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerUserBotDeleteRoute(routes, {
      ...options.userBotDelete!, requireUser: async (request) => { void userFromRequest(request) },
      ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.userBotCreate) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerUserBotCreateRoute(routes, {
      ...options.userBotCreate!, requireUser: async (request) => { void userFromRequest(request) },
      ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.userBotUnbind) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerUserBotUnbindRoute(routes, { ...options.userBotUnbind!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId }))
  }
  registerMcpRoutes(app, auth, options)
  if (options.attentionDefaults) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerAttentionDefaultsRoute(routes, { ...options.attentionDefaults!, requireUser: async request => { void userFromRequest(request) } }))
  }
  if (options.loopScopeProxy) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerLoopScopeProxyRoutes(routes, { ...options.loopScopeProxy!, requireUser: async request => { void userFromRequest(request) } }))
  }
  registerAttachmentRoutes(app, auth, options)
  if (options.voiceAvailability) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerVoiceAvailabilityRoute(routes, {
      ...options.voiceAvailability!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.clearAgentMemory) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerMemoryClearRoute(routes, {
      clear: options.clearAgentMemory!.clear,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  registerTerminalRoutes(app, auth, options)
  if (options.userBotsList) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerUserBotsListRoute(routes, { ...options.userBotsList!,
        requireUser: async request => { void userFromRequest(request) },
        ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId })
    })
  }
  if (options.embeddingRebuildStatus) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerEmbeddingRebuildStatusRoute(routes, { ...options.embeddingRebuildStatus!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId }))
  }
  if (options.embeddingRebuild) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerEmbeddingRebuildRoute(routes, { ...options.embeddingRebuild!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId }))
  }
  if (options.taskFilesystemAuthorization) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerTaskFilesystemAuthorizationRoutes(routes, { ...options.taskFilesystemAuthorization!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId }))
  }
  if (options.taskFilesystemRevoke) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerTaskFilesystemRevokeRoute(routes, { ...options.taskFilesystemRevoke!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId }))
  }
  registerByokRoutes(app, auth, options)
  if (options.desktopAgentDeepResearch)
    registerDesktopAgentDeepResearchRoute(app, auth, options.desktopAgentDeepResearch)
  if (options.desktopAgentSimilarImageSearch)
    registerDesktopAgentSimilarImageRoute(app, auth, options.desktopAgentSimilarImageSearch)
  registerMailRoutes(app, auth)
  if (options.userSkillDelete) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerUserSkillDeleteRoute(routes, { ...options.userSkillDelete!,
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId })
    })
  }
  if (options.userSkillList) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerUserSkillListRoute(routes, {
      ...options.userSkillList!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.userSkillWrite) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerUserSkillWriteRoutes(routes, {
      ...options.userSkillWrite!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.accountDelete) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => registerAccountDeleteRoute(routes, {
      ...options.accountDelete!,
      requireUser: async request => { void userFromRequest(request) },
      ownerIdFromRequest: request => userFromRequest(request).requestContext.data.ownerId,
    }))
  }
  if (options.onboarding || options.onboardingReseed) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      const requireUser = async (request: FastifyRequest) => { void userFromRequest(request) }
      const ownerIdFromRequest = (request: FastifyRequest) => userFromRequest(request).requestContext.data.ownerId
      if (options.onboarding) {
        registerOnboardingResetGuideRoute(routes, { requireUser, ownerIdFromRequest, store: options.onboarding })
        registerOnboardingRoutes(routes, { requireUser, ownerIdFromRequest, store: options.onboarding })
      }
      if (options.onboardingReseed)
        registerOnboardingReseedRoute(routes, { requireUser, ownerIdFromRequest, reseed: options.onboardingReseed })
    })
  }
  if (options.listProjects || options.createProject || options.listProjectFileCounts || options.getProject
    || options.updateProject || options.deleteProject || options.restoreProject) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) => {
      registerProjectRoutes(routes, userFromRequest, options)
    })
  }
  if (options.clients)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerClientRoutes(routes, userFromRequest, options.clients!),
    )
  if (options.events)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerEventRoutes(routes, userFromRequest, options.events!),
    )
  registerMindRoutes(app, auth, options)
  if (options.undo)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerUndoRoutes(routes, userFromRequest, options.undo!),
    )
  if (options.deleteScheduledTask)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerScheduledTaskDelete(routes, userFromRequest, options.deleteScheduledTask!),
    )
  if (options.listScheduledTasks)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerScheduledTaskList(routes, userFromRequest, options.listScheduledTasks!),
    )
  if (options.scheduledTaskDeliveryTargets)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerScheduledTaskDeliveryTargets(routes, userFromRequest, options.scheduledTaskDeliveryTargets!),
    )
  if (options.scheduledTaskTestNotify)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerScheduledTaskTestNotify(routes, userFromRequest, options.scheduledTaskTestNotify!),
    )
  if (options.scheduledTaskWrites)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerScheduledTaskWrites(routes, userFromRequest, options.scheduledTaskWrites!),
    )
  if (options.scheduledTaskRunNow)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerScheduledTaskRunNow(routes, userFromRequest, options.scheduledTaskRunNow!),
    )
  if (options.notifications)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerNotificationRoutes(routes, userFromRequest, options.notifications!),
    )
  if (options.track)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerTrackRoute(routes, userFromRequest, options.track!),
    )
  if (options.feedback)
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerFeedbackRoute(routes, userFromRequest, options.feedback!),
    )
  if (options.createWorkspace || options.listWorkspaces || options.workspaceBindings
    || options.updateWorkspace || options.deleteWorkspace) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerWorkspaceRoutes(
        routes,
        userFromRequest,
        options.createWorkspace,
        options.workspaceBindings,
        options.updateWorkspace,
        options.listWorkspaces,
        options.deleteWorkspace,
      ),
    )
  }
  if (options.workspaceDirectories) {
    registerProtectedDomain(app, auth, (routes, userFromRequest) =>
      registerWorkspaceDirectoryRoutes(routes, {
        requireUser: async (request) => { void userFromRequest(request) },
        ownerIdFromRequest: (request) => userFromRequest(request).requestContext.data.ownerId,
        operations: options.workspaceDirectories!,
      }),
    )
  }
  registerAgentRoutes(app, auth, options)
  registerFileRoutes(app, auth, options)

}
